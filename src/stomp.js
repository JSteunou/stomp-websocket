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
