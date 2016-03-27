// Define constants for bytes used throughout the code.
// LINEFEED byte (octet 10)
const BYTES_LF = '\x0A';
// NULL byte (octet 0)
const BYTES_NULL = '\x00';

// utility function to trim any whitespace before and after a string
const trim = (str) => str.replace(/^\s+|\s+$/g,'');



// [STOMP Frame](http://stomp.github.com/stomp-specification-1.1.html#STOMP_Frames) Class
class Frame {

    // Frame constructor
    constructor(command, headers={}, body='') {
        this.command = command;
        this.headers = headers;
        this.body = body;
    }

    // Provides a textual representation of the frame
    // suitable to be sent to the server
    toString() {
        let lines = [this.command],
            skipContentLength = this.headers['content-length'] === false
        ;
        if (skipContentLength) delete this.headers['content-length'];

        Object.keys(this.headers).forEach(name => {
            let value = this.headers[name];
            lines.push(`${name}:${value}`);
        });

        if (this.body && !skipContentLength) {
            lines.push(`content-length:${Frame.sizeOfUTF8(this.body)}`);
        }

        lines.push(BYTES.LF + this.body);

        return lines.join(BYTES.LF);
    }

    // Compute the size of a UTF-8 string by counting its number of bytes
    // (and not the number of characters composing the string)
    static sizeOfUTF8(s) {
        if (!s) return 0;
        return encodeURI(s).match(/%..|./g).length;
    }

    // Unmarshall a single STOMP frame from a `data` string
    static unmarshallSingle(data) {
        // search for 2 consecutives LF byte to split the command
        // and headers from the body
        let divider = data.search(new RegExp(BYTES_LF + BYTES_LF)),
            headerLines = data.substring(0, divider).split(BYTES_LF),
            command = headerLines.shift(),
            headers = {},
            body = '',
            // skip the 2 LF bytes that divides the headers from the body
            bodyIndex = divider + 2
        ;
        // Parse headers in reverse order so that for repeated headers, the 1st
        // value is used
        for (let line of headerLines.reverse()) {
            let idx = line.indexOf(':');
            headers[trim(line.substring(0, idx))] = trim(line.substring(idx + 1));
        }
        // Parse body
        // check for content-length or topping at the first NULL byte found.
        if (headers['content-length']) {
            let len = parseInt(headers['content-length'], 10);
            body = ('' + data).substring(bodyIndex, bodyIndex + len);
        } else {
            let chr = null;
            for (let i = bodyIndex; i < data.length; i++) {
                chr = data.charAt(i);
                if (chr === BYTES_NULL) break;
                body += chr;
            }
        }

        return new Frame(command, headers, body);
    }

    // Split the data before unmarshalling every single STOMP frame.
    // Web socket servers can send multiple frames in a single websocket message.
    // If the message size exceeds the websocket message size, then a single
    // frame can be fragmented across multiple messages.
    //
    // `datas` is a string.
    //
    // returns an *array* of Frame objects
    static unmarshall(datas) {
        // split and unmarshall *multiple STOMP frames* contained in a *single WebSocket frame*.
        // The data is split when a NULL byte (followed by zero or many LF bytes) is found
        let frames = datas.split(new RegExp(BYTES_NULL + BYTES_LF + '*')),
            firstFrames = frames.slice(0, -1),
            lastFrame = frames.slice(-1)[0],
            r = {
                frames: firstFrames.map(f => unmarshallSingle(f)),
                partial: ''
            }
        ;

        // If this contains a final full message or just a acknowledgement of a PING
        // without any other content, process this frame, otherwise return the
        // contents of the buffer to the caller.
        if (lastFrame === Byte.LF || (lastFrame.search(RegExp(BYTES_NULL + BYTES_LF + '*$'))) !== -1) {
            r.frames.push(unmarshallSingle(lastFrame));
        } else {
            r.partial = lastFrame;
        }

        return r;
    }

    // Marshall a Stomp frame
    static marshall(command, headers, body) {
        let frame = new Frame(command, headers, body);
        return frame.toString() + BYTES_NULL;
    }

}

// STOMP Client Class
//
// All STOMP protocol is exposed as methods of this class (`connect()`,
// `send()`, etc.)
class Client {

    constructor(ws) {
        this.ws = ws;
        this.ws.binaryType = 'arraybuffer';
        // used to index subscribers
        this.counter = 0;
        this.connected = false;
        // Heartbeat properties of the client
        this.heartbeat = {
          // send heartbeat every 10s by default (value is in ms)
          outgoing: 10000,
          // expect to receive server heartbeat at least every 10s by default
          // (value in ms)
          incoming: 10000
        };
        // maximum *WebSocket* frame size sent by the client. If the STOMP frame
        // is bigger than this value, the STOMP frame will be sent using multiple
        // WebSocket frames (default is 16KiB)
        this.maxWebSocketFrameSize = 16 * 1024;
        // subscription callbacks indexed by subscriber's ID
        this.subscriptions = {};
        this.partialData = '';
    }

    // //// Debugging
    //
    // By default, debug messages are logged in the window's console if it is defined.
    // This method is called for every actual transmission of the STOMP frames over the
    // WebSocket.
    //
    // It is possible to set a `debug(message)` method
    // on a client instance to handle differently the debug messages:
    //
    //     client.debug = function(str) {
    //         // append the debug log to a #debug div
    //         $("#debug").append(str + "\n");
    //     };
    debug(message) {
        if (window && window.console) window.console.log(message);
    }

    // [CONNECT Frame](http://stomp.github.com/stomp-specification-1.1.html#CONNECT_or_STOMP_Frame)
    //
    // The `connect` method accepts different number of arguments and types:
    //
    // * `connect(headers, connectCallback)`
    // * `connect(headers, connectCallback, errorCallback)`
    // * `connect(login, passcode, connectCallback)`
    // * `connect(login, passcode, connectCallback, errorCallback)`
    // * `connect(login, passcode, connectCallback, errorCallback, host)`
    //
    // The errorCallback is optional and the 2 first forms allow to pass other
    // headers in addition to `client`, `passcode` and `host`.
    connect(...args) {
        let [headers, connectCallback, errorCallback] = this._parseConnect(...args);
        this.connectCallback = connectCallback;
        this.debug('Opening Web Socket...');
        this.ws.onmessage = (evt) => {
            let data = evt.data;
            if (evt.data instanceof ArrayBuffer) {
                // the data is stored inside an ArrayBuffer, we decode it to get the
                // data as a String
                const arr = new Uint8Array(evt.data);
                this.debug('--- got data length: ${arr.length}');
                // Return a string formed by all the char codes stored in the Uint8array
                data = arr.map(c => String.fromCharCode(c)).join('');
            }
            this.serverActivity = Date.now();
            // heartbeat
            if (data === Byte.LF) {
                this.debug('<<< PONG');
                return;
            }
            this.debug(`<<< ${data}`);
            // Handle STOMP frames received from the server
            // The unmarshall function returns the frames parsed and any remaining
            // data from partial frames.
            const unmarshalledData = Frame.unmarshall(this.partialData + data);
            this.partialData = unmarshalledData.partial;
            unmarshalledData.frames.forEach(frame => {
                switch (frame.command) {
                    // [CONNECTED Frame](http://stomp.github.com/stomp-specification-1.1.html#CONNECTED_Frame)
                    case 'CONNECTED':
                        this.debug(`connected to server ${frame.headers.server}`);
                        this.connected = true;
                        this._setupHeartbeat(frame.headers);
                        if (connectCallback) connectCallback(frame);
                        break;
                    // [MESSAGE Frame](http://stomp.github.com/stomp-specification-1.1.html#MESSAGE)
                    case 'MESSAGE':
                        // the `onreceive` callback is registered when the client calls
                        // `subscribe()`.
                        // If there is registered subscription for the received message,
                        // we used the default `onreceive` method that the client can set.
                        // This is useful for subscriptions that are automatically created
                        // on the browser side (e.g. [RabbitMQ's temporary
                        // queues](http://www.rabbitmq.com/stomp.html)).
                        const subscription = frame.headers.subscription;
                        const onreceive = this.subscriptions[subscription] || this.onreceive;
                        if (onreceive) {
                            const messageID = frame.headers['message-id'];
                            // add `ack()` and `nack()` methods directly to the returned frame
                            // so that a simple call to `message.ack()` can acknowledge the message.
                            frame.ack = this.ack.bind(this, messageID, subscription);
                            frame.nack = this.nack.bind(this, messageID, subscription);
                            onreceive(frame);
                        } else {
                            this.debug(`Unhandled received MESSAGE: ${frame}`);
                        }
                        break;
                    // [RECEIPT Frame](http://stomp.github.com/stomp-specification-1.1.html#RECEIPT)
                    //
                    // The client instance can set its `onreceipt` field to a function taking
                    // a frame argument that will be called when a receipt is received from
                    // the server:
                    //
                    //     client.onreceipt = function(frame) {
                    //       receiptID = frame.headers['receipt-id'];
                    //       ...
                    //     }
                    case 'RECEIPT':
                        if (this.onreceipt) this.onreceipt(frame);
                        break;
                    // [ERROR Frame](http://stomp.github.com/stomp-specification-1.1.html#ERROR)
                    case 'ERROR':
                        if (errorCallback) errorCallback(frame);
                        break;
                    default:
                        this.debug(`Unhandled frame: ${frame}`);
                }
            });
        };
        this.ws.onclose = () => {
            const msg = `Whoops! Lost connection to ${this.ws.url}`;
            this.debug(msg);
            this._cleanUp();
            if (errorCallback) errorCallback(msg);
        };
        this.ws.onopen = () => {
            this.debug('Web Socket Opened...');
            headers['accept-version'] = Stomp.VERSIONS.supportedVersions();
            headers['heart-beat'] = [this.heartbeat.outgoing, this.heartbeat.incoming].join(',');
            this._transmit('CONNECT', headers);
        };
    }

    // [DISCONNECT Frame](http://stomp.github.com/stomp-specification-1.1.html#DISCONNECT)
    disconnect(disconnectCallback, headers={}) {
        this._transmit('DISCONNECT', headers);
        // Discard the onclose callback to avoid calling the errorCallback when
        // the client is properly disconnected.
        // TODO: onclose should be triggered anyway
        this.ws.onclose = null;
        this.ws.close();
        this._cleanUp();
        // TODO: what's the point of this callback disconnect is not async
        if (disconnectCallback) disconnectCallback();
    }

    // [SEND Frame](http://stomp.github.com/stomp-specification-1.1.html#SEND)
    //
    // * `destination` is MANDATORY.
    send(destination, headers={}, body='') {
        headers.destination = destination;
        this._transmit('SEND', headers, body);
    }

    // [BEGIN Frame](http://stomp.github.com/stomp-specification-1.1.html#BEGIN)
    //
    // If no transaction ID is passed, one will be created automatically
    begin(transaction=`tx-${this.counter++}`) {
        this._transmit('BEGIN', {transaction});
        return {
            id: transaction,
            commit: this.commit.bind(this, transaction),
            abort: this.abort.bind(this, transaction)
        };
    }

    // [COMMIT Frame](http://stomp.github.com/stomp-specification-1.1.html#COMMIT)
    //
    // * `transaction` is MANDATORY.
    //
    // It is preferable to commit a transaction by calling `commit()` directly on
    // the object returned by `client.begin()`:
    //
    //     var tx = client.begin(txid);
    //     ...
    //     tx.commit();
    commit(transaction) {
        this._transmit('COMMIT', {transaction});
    }

    // [ABORT Frame](http://stomp.github.com/stomp-specification-1.1.html#ABORT)
    //
    // * `transaction` is MANDATORY.
    //
    // It is preferable to abort a transaction by calling `abort()` directly on
    // the object returned by `client.begin()`:
    //
    //     var tx = client.begin(txid);
    //     ...
    //     tx.abort();
    abort(transaction) {
        this._transmit('ABORT', {transaction});
    }

    // [ACK Frame](http://stomp.github.com/stomp-specification-1.1.html#ACK)
    //
    // * `messageID` & `subscription` are MANDATORY.
    //
    // It is preferable to acknowledge a message by calling `ack()` directly
    // on the message handled by a subscription callback:
    //
    //     client.subscribe(destination,
    //       function(message) {
    //         // process the message
    //         // acknowledge it
    //         message.ack();
    //       },
    //       {'ack': 'client'}
    //     );
    ack(messageID, subscription, headers = {}) {
        headers['message-id'] = messageID;
        headers.subscription = subscription;
        this._transmit('ACK', headers);
    }

    // [NACK Frame](http://stomp.github.com/stomp-specification-1.1.html#NACK)
    //
    // * `messageID` & `subscription` are MANDATORY.
    //
    // It is preferable to nack a message by calling `nack()` directly on the
    // message handled by a subscription callback:
    //
    //     client.subscribe(destination,
    //       function(message) {
    //         // process the message
    //         // an error occurs, nack it
    //         message.nack();
    //       },
    //       {'ack': 'client'}
    //     );
    nack(messageID, subscription, headers = {}) {
        headers['message-id'] = messageID;
        headers.subscription = subscription;
        this._transmit('NACK', headers);
    }

    // [SUBSCRIBE Frame](http://stomp.github.com/stomp-specification-1.1.html#SUBSCRIBE)
    subscribe(destination, callback, headers={}) {
        // for convenience if the `id` header is not set, we create a new one for this client
        // that will be returned to be able to unsubscribe this subscription
        if (!headers.id) headers.id = 'sub-' + this.counter++;
        headers.destination = destination;
        this.subscriptions[headers.id] = callback;
        this._transmit('SUBSCRIBE', headers);
        return {
            id: headers.id,
            unsubscribe: this.unsubscribe.bind(this, headers.id)
        };
    }

    // [UNSUBSCRIBE Frame](http://stomp.github.com/stomp-specification-1.1.html#UNSUBSCRIBE)
    //
    // * `id` is MANDATORY.
    //
    // It is preferable to unsubscribe from a subscription by calling
    // `unsubscribe()` directly on the object returned by `client.subscribe()`:
    //
    //     var subscription = client.subscribe(destination, onmessage);
    //     ...
    //     subscription.unsubscribe();
    unsubscribe(id) {
        delete this.subscriptions[id];
        this._transmit('UNSUBSCRIBE', {id});
    }



    // Clean up client resources when it is disconnected or the server did not
    // send heart beats in a timely fashion
    _cleanUp() {
        this.connected = false
        Stomp.clearInterval(this.pinger);
        Stomp.clearInterval(this.ponger);
    }

    // Base method to transmit any stomp frame
    _transmit(command, headers, body) {
        let out = Frame.marshall(command, headers, body);
        this.debug(`>>> ${out}`);
        // if necessary, split the *STOMP* frame to send it on many smaller
        // *WebSocket* frames
        while (true) {
            if (out.length > this.maxWebSocketFrameSize) {
                this.ws.send(out.substring(0, this.maxWebSocketFrameSize));
                out = out.substring(this.maxWebSocketFrameSize);
                this.debug(`remaining = ${out.length}`);
            } else {
                return this.ws.send(out);
            }
        }
    }

    // Heart-beat negotiation
    _setupHeartbeat(headers) {
        if (headers.version !== Stomp.VERSIONS.V1_1 || headers.version !== Stomp.VERSIONS.V1_2) return;

        // heart-beat header received from the server looks like:
        //
        //     heart-beat: sx, sy
        [serverOutgoing, serverIncoming] = headers['heart-beat'].split(',').map(v => parseInt(v, 10));

        if (!(this.heartbeat.outgoing === 0 || serverIncoming === 0)) {
            let ttl = Math.max(this.heartbeat.outgoing, serverIncoming);
            this.debug('send PING every #{ttl}ms');
            this.pinger = setInterval(ttl => {
                this.ws.send(BYTES_LF);
                this.debug('>>> PING');
            });
        }

        if(!(this.heartbeat.incoming === 0 || serverOutgoing === 0)) {
            let ttl = Math.max(this.heartbeat.incoming, serverOutgoing);
            this.debug('check PONG every #{ttl}ms');
            this.ponger = setInterval(ttl => {
                let delta = Date.now() - this.serverActivity;
                // We wait twice the TTL to be flexible on window's setInterval calls
                if (delta > ttl * 2) {
                    this.debug('did not receive server activity for the last #{delta}ms');
                    this.ws.close();
                }
            });
        }
    }

    // parse the arguments number and type to find the headers, connectCallback and
    // (eventually undefined) errorCallback
    _parseConnect(...args) {
        let headers = {}, connectCallback, errorCallback;
        switch (args.length) {
            case 2:
                [headers, connectCallback] = args;
                break;
            case 3:
                if (args[1] instanceof Function) {
                    [headers, connectCallback, errorCallback] = args;
                } else {
                    [headers.login, headers.passcode, connectCallback] = args;
                }
                break;
            case 4:
                [headers.login, headers.passcode, connectCallback, errorCallback] = args;
                break;
            default:
                [headers.login, headers.passcode, connectCallback, errorCallback, headers.host] = args;
        }

        return [headers, connectCallback, errorCallback];
    }

}
