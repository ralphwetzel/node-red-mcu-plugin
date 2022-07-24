const EventEmitter = require("events");
const net = require('node:net');
const X2JS = require("x2js");

class mcuProxy extends EventEmitter {

    // This code derives from an idea of @phoddie

    constructor(portIn, portOut, relay, trace) {

        super();

        this.portIn = portIn || 5004;
        this.portOut = portOut || 5002;
        this.relay = relay || true;
        this.trace = trace || false;
        this.x2js = new X2JS();

        this.inCache = '';
        this.xsbug;
        this.target;

        this.server = net.createServer(target => { 

            this.target = target;

            let xsbug = this.xsbug;
            if (xsbug) {
                this.disconnect();
            }

            if (this.trace)
                console.log('mcuProxy: Target connected.');
        
            if (this.relay) {
                // connect to xsbug to be able to relay messages
                xsbug = net.connect({
                    port: this.portOut,
                    host: "localhost"
                });
                
                xsbug.setEncoding("utf8");
                xsbug.on('ready', data => {
                    while (xsbug.deferred.length)
                        xsbug.write(xsbug.deferred.shift());
                    delete xsbug.deferred;
                });
                xsbug.on('data', data => {
                    // data = JSON.stringify(data);
                    if (this.trace)
                        console.log("mcuProxy: From xsbug => " + data);
                    target.write(data);
                });
                xsbug.on('end', () => {
                    if (this.trace)
                        console.log("mcuProxy: xsbug disconnected.");
                    target.destroy();
                });
                xsbug.deferred = [];
                xsbug.deferred.push("2");
            }
        
            target.setEncoding("utf8");
            let first = true;
            target.on('data', data => {

                if (this.trace) {
                    console.log("mcuProxy: From Target => " + data);
                }

                this.inCache += data.toString().trim();

                // parse messages here
                // each message is an XML document
                // status messages are sent in a bubble right message of the form:
                // <xsbug><bubble name="" value="2" path="/Users/hoddie/Projects/moddable/examples/helloworld/main.js" line="18">JSON STATUS MESSAGE HERE</bubble></xsbug>

                if (this.inCache.slice(0,7) == "<xsbug>" && this.inCache.slice(-8) == "</xsbug>") {
                    let doc = this.x2js.xml2js(this.inCache);
                    this.inCache = "";
                    if (doc.xsbug && doc.xsbug.bubble && doc.xsbug.bubble.__text) {
                        let msg = JSON.parse(doc.xsbug.bubble.__text);
                        if (msg.status) {
                            this.emit("status", msg.status)
                        }
                    }
                }

                if (this.relay && xsbug) { 
                    if (xsbug.deferred)
                        xsbug.deferred.push(data);
                    else
                        xsbug.write(data);
                }
                else {
                    if (first) {
                        // first time need to send set-all-breakpoints as xsbug does
                        first = false;;
                        target.write('\r\n<set-all-breakpoints><breakpoint path="exceptions" line="0"/></set-all-breakpoints>\r\n');
                    }
                    else {
                        // assume any other messages are a break, so send go. This isn't always corrrect but may always work.
                        target.write('\r\n<go/>\r\n');
                    }
                }
            });
            target.on('end', () => {
                if (this.trace)
                    console.log('mcuProxy: Target disconnected.');
                if (xsbug)
                    xsbug.destroy();
            });
            target.on("error", () => {
                // we should emit an error here...
            });
        });
        
        this.server.listen(this.portIn, () => { 
           console.log('mcuProxy: Listening!');
        });
    }

    send2mcu(command, flow, node, data) {

        if (this.target) {
            let target = this.target;
            const options = {
                command: command,
                flow: flow,
                id: node,
                data: data
            };
            try {
                target.write(`\r\n<script path="" line="0"><![CDATA[${JSON.stringify(options)}]]></script>\r\n`);
            }
            catch (err) {}
		}
    }

    disconnect() {
        if (this.xsbug) {
            this.xsbug.destroy();
        }
        this.xsbug = undefined;

        if (this.server) {
            this.server.close();
        }
        this.server = undefined;

        // TODO: we should try to disco fromm the mcu as well!
    }
}

module.exports = {
    proxy: mcuProxy
}
