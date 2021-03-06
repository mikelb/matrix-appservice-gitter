"use strict";

function BridgedRoom(opts) {
    this._bridge = opts.bridge;
    this._gitter = opts.gitter;
    this._gitterRealtime = opts.gitterRealtime;
    this._gitterRoomName = opts.gitterRoomName;
    this._linkedMatrixRoomIds = [];
    this._portalMatrixRoomId = null;

    // Set as a side-effect of joinAndStart
    this._gitterUserId = null;
    this._gitterRoom = null;

    // The most recent message model object sent in this room from the gitter
    //   side, keyed by user ID. This is useful if the user sends an update,
    //   so we can diff it
    this._previousMessages = {};
}

BridgedRoom.prototype.gitterRoomName = function() {
    return this._gitterRoomName;
};

BridgedRoom.prototype.linkMatrixRoom = function(matrixRoomId) {
    this._linkedMatrixRoomIds.push(matrixRoomId);
};

// returns a Promise, which will resolve to nothing. If the room needs to be
//   stopped and left on the gitter side because it has no matrix links
//   remaining, this promise will not resolve until that is done.
BridgedRoom.prototype.unlinkMatrixRoom = function(matrixRoomId) {
    this._linkedMatrixRoomIds = this._linkedMatrixRoomIds.filter((id) =>
        id !== matrixRoomId
    );

    if (this._linkedMatrixRoomIds.length || this._portalMatrixRoomId) {
        // We still need the room - don't stop it yet
        return Promise.resolve();
    }

    return this.stopAndLeave();
};

BridgedRoom.prototype.getLinkedMatrixRoomIds = function() {
    return this._linkedMatrixRoomIds;
};

BridgedRoom.prototype.setPortalMatrixRoomId = function(matrixRoomId) {
    // TODO(paul): prevent non-null -> non-null transitions
    this._portalMatrixRoomId = matrixRoomId;
};

BridgedRoom.prototype.getPortalMatrixRoomId = function() {
    return this._portalMatrixRoomId;
};

BridgedRoom.prototype.getAllMatrixRoomIds = function() {
    var ret = this._linkedMatrixRoomIds.slice(); // clone
    if (this._portalMatrixRoomId) ret.push(this._portalMatrixRoomId);
    return ret;
};

BridgedRoom.prototype.joinAndStart = function() {
    // We have to find out our own gitter user ID so we can ignore reflections of
    // messages we sent
    return this._bridge.getMyGitterUserId().then((gitterUserId) => {
        this._gitterUserId = gitterUserId;

        this._bridge.incRemoteCallCounter("room.join");
        return this._gitter.rooms.join(this.gitterRoomName());
    }).then((room) => {
        this._gitterRoom = room;

        var events = room.streaming().chatMessages();

        events.on('chatMessages', (event) => {
            if (!event.model) return;

            if (!event.model.fromUser || event.model.fromUser.id == this._gitterUserId) {
                // Ignore a reflection of my own messages
                return;
            }

            if (event.operation == 'create' || event.operation == 'update') {
                this.onGitterMessage(event.model);
            }
        });

        this._gitterRealtime.subscribe("/v1/rooms/" + room.id, (message) => {
            this._bridge.getGitterUserById(message.userId).then((user) => {
                if (user) {
                    user.setRoomPresence(room.id, message.status == 'in');
                }
            });
        });
    });
};

BridgedRoom.prototype.stopAndLeave = function() {
    this._gitterRoom.streaming().disconnect();

    this._bridge.incRemoteCallCounter("room.leave");
    return this._gitterRoom.removeUser(this._gitterUserId);
};

function quotemeta(s) { return s.replace(/\W/g, '\\$&'); }

// idx counts backwards from the end of the string; 0 is final character
function rcharAt(s,idx) { return s.charAt(s.length-1 - idx); }

function firstWord(s) {
    var groups = s.match(/^\s*\S+/);
    return groups ? groups[0] : "";
}

function finalWord(s) {
    var groups = s.match(/\S+\s*$/);
    return groups ? groups[0] : "";
}

function htmlEscape(s) {
    return s.replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
}

BridgedRoom.prototype.onGitterMessage = function(message) {
    // Each message follows the model given in
    //   https://developer.gitter.im/docs/messages-resource
    var fromUser = message.fromUser;

    this._bridge.incCounter("received_messages", {side: "remote"});
    console.log('gitter->' + this.gitterRoomName() + ' from ' + fromUser.username + ':', message.text);

    var prevMessage;

    if (message.v > 1) {
        // versions above 1 are updates. Lets see if we have the previous
        // version
        prevMessage = this._previousMessages[fromUser.id];
    }

    this._previousMessages[fromUser.id] = message;

    this._bridge.mapGitterUser(fromUser).then((user) => {
        return user.update(fromUser)
            .catch((e) => {
                console.log("Updating user failed:", e);
                // There's a lot that could go wrong in user.update(); e.g. the avatar
                //   image could be corrupted and the matrix media server would reject
                //   it. Lets not let a failure there get in the way of message
                //   relaying - we'll ignore the failure here and continue anyway.
            }).then(() => {
                return user;
            });
    }).then((user) => {
        var matrixMessage = {
            msgtype: "m.text",
            body: message.text,
        };

        if (prevMessage) {
            // Matrix doesn't (yet) support message edits. See
            //   https://matrix.org/jira/browse/SPEC-410
            //
            // For now we'll note that 99% of edits in gitter are people
            //   performing little typo fixes or other small edits. We'll
            //   detect a common prefix and suffix and show only the edited
            //   region in a helpfully marked-up way.

            var prev = prevMessage.text;
            var curr = message.text;

            // TODO(paul): for now I'll ignore diffing of formatted messages
            //   because I really don't fancy an HTML-tagged formatting aware
            //   version of this algorithm

            // Find the length of the common prefix and suffix

            // TODO(paul): this code all sucks. It works fine in BMP unicode
            //   without combining marks. It will break in the presence of
            //   non-BMP codepoints (because of split UTF-16 surrogates) or
            //   differences in combining marks on the same base character.
            //   I don't fancy fixing this right now.
            var i;
            for (i = 0; i < curr.length && i < prev.length; i++) {
                if (curr.charAt(i) != prev.charAt(i)) break;
            }
            // retreat to the start of a word
            while(i > 0 && /\S/.test(curr.charAt(i-1))) i--;

            var prefixLen = i;

            for(i = 0; i < curr.length && i < prev.length; i++) {
                if (rcharAt(curr, i) != rcharAt(prev, i)) break;
            }
            // advance to the end of a word
            while(i > 0 && /\S/.test(rcharAt(curr, i-1))) i--;

            var suffixLen = i;

            // Extract the common prefix and suffix strings themselves and
            //   mutate the prev/curr strings to only contain the differing
            //   middle region
            var prefix = curr.slice(0, prefixLen);
            curr = curr.slice(prefixLen);
            prev = prev.slice(prefixLen);

            var suffix = "";
            if (suffixLen > 0) {
                suffix = curr.slice(-suffixLen);
                curr = curr.slice(0, -suffixLen);
                prev = prev.slice(0, -suffixLen);
            }

            // At this point, we have four strings; the common prefix and
            //   suffix, and the edited middle part. To display it nicely as a
            //   matrix message we'll use the final word of the prefix and the
            //   first word of the suffix as "context" for a customly-formatted
            //   message.

            var before = finalWord(prefix);
            if (before != prefix) { before = "... " + before; }

            var after = firstWord(suffix);
            if (after != suffix) { after = after + " ..."; }

            matrixMessage.body = "(edited) " +
                before + prev + after + " => " +
                before + curr + after;

            prev   = htmlEscape(prev);
            curr   = htmlEscape(curr);
            before = htmlEscape(before);
            after  = htmlEscape(after);

            matrixMessage.format = "org.matrix.custom.html";
            matrixMessage.formatted_body = "<i>(edited)</i> " +
                before + '<font color="red">'   + prev + '</font>' + after + " =&gt; " +
                before + '<font color="green">' + curr + '</font>' + after;
        }
        else {
            // Pull out the HTML part of the body if it's not just plain text
            if (message.html != message.text) {
                matrixMessage.format = "org.matrix.custom.html";
                matrixMessage.formatted_body = message.html;
            }

            if (message.status) {
                matrixMessage.msgtype = "m.emote";

                // Strip the leading @username mention from the body text
                var userNameQuoted = quotemeta(fromUser.username);

                // Turn  "@username does something here" into "does something here"
                matrixMessage.body =
                    matrixMessage.body.replace(new RegExp("^@" + userNameQuoted + " "), "");

                // HTML is harder. Applying regexp mangling to an HTML string. Not a lot
                //   better we can do about this, unless gitter gives us the underlying
                //   message in a better way.

                // Turn
                //   <span class="mention" ...>@username</span> does something here
                // into
                //   does something here
                matrixMessage.formatted_body =
                    matrixMessage.formatted_body.replace(new RegExp("^<span [^>]+>@" + userNameQuoted + "</span> "), "");
            }
        }

        this.getAllMatrixRoomIds().forEach((matrixRoomId) => {
            return user.getIntent().sendMessage(matrixRoomId, matrixMessage).then(() => {
                this._bridge.incCounter("sent_messages", {side: "matrix"});
            });
        });
    });
};

BridgedRoom.prototype.onMatrixMessage = function(message) {
    this._bridge.incCounter("received_messages", {side: "matrix"});

    var from = this._bridge.mangleName(message.user_id);

    // gitter supports Markdown. We'll use that to apply a little formatting
    // to make understanding the text a little easier
    if (message.content.msgtype == 'm.emote') {
        // wrap emote messages in *italics*
        // We'll have to also escape any *s in the message so they don't confuse
        //   markdown
        var text = '*' + (from + ' ' + message.content.body).replace(/\*/g, '\\*') + '*';
        this._gitterRoom.sendStatus(text);
        this._bridge.incCounter("sent_messages", {side: "remote"});
    }
    else {
        // wrap the sender of a normal message in `fixedwidth` notation
        var text = '`' + from + '` ' + message.content.body;
        this._gitterRoom.send(text);
        this._bridge.incCounter("sent_messages", {side: "remote"});
    }

    // Reflect the message to other Matrix rooms linked to the same Gitter one
    // These appear using the bot's own user acting as a ghost for the things
    //   it said on the Gitter side.
    this.getAllMatrixRoomIds().forEach((matrixRoomId) => {
        if (matrixRoomId === message.room_id) return;

        this._bridge.getBotIntent().sendMessage(
            matrixRoomId, {
                msgtype: "m.text",
                body: "`"+from+"` "+message.content.body,

                format: "org.matrix.custom.html",
                formatted_body: "<code>"+from+"</code> "+message.content.body,
            }
        ).then(() => {
            this._bridge.incCounter("sent_messages", {side: "remote"});
        });
    });
};

module.exports = BridgedRoom;
