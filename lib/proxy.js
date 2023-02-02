const EventEmitter = require("events");
// const net = require('node:net'); // <== Node16
const net = require('net');     // <== Node14
// const X2JS = require("x2js");
const {XMLParser} = require('fast-xml-parser');



class mcuProxy extends EventEmitter {

    // This code derives from an idea of @phoddie

    constructor(portIn, portOut, relay, trace) {

        super();

        this.portIn = portIn || 5004;
        this.portOut = portOut || 5002;
        this.relay = relay || true;
        this.trace = trace || false;

        this.inCache = '';
        this.xsbug;
        this.target;

        console.log("Launching mcuProxy:");
        this.server = net.createServer(target => { 

            this.target = target;

            if (this.trace)
                console.log('mcuProxy: Target connected.');
        
            if (this.relay) {
                // connect to xsbug to be able to relay messages

                try {
                    this.xsbug = net.connect({
                        port: this.portOut,
                        host: "127.0.0.1"
                    });    
                } catch (err) {
                    console.log("- Failed to connect to xsbug: " + err.message);
                    this.xsbug = undefined;
                    return;
                }
                
                let xsbug = this.xsbug;

                xsbug.setEncoding("utf8");
                xsbug.on('lookup', (err, address, family, host) => {
                    if (err) {
                        console.log(`- Connecting to xsbug: Error while trying to resolve ${host}: ` + err.message);
                    } else {
                        console.log(`- Connecting to xsbug: Resolved ${host} to ${address}/${family}.`);
                    }
                });
                xsbug.on("connect", () => {
                    let c = xsbug.address();
                    console.log(`- Connected to xsbug @ ${c.address}:${c.port}/${c.family}.`);
                })
                xsbug.on('ready', data => {
                    while (xsbug.deferred.length)
                        xsbug.write(xsbug.deferred.shift() + "\r\n");
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
                xsbug.on('error', () => {
                    try {
                        this.xsbug.destroy();
                    } catch(err) {}
                    this.xsbug = undefined;
                });
                xsbug.deferred = [];
                xsbug.deferred.push("2");
            }
        
            target.setEncoding("utf8");
            let first = true;
            target.on('data', data => {

                if (this.trace) {
                    console.log("mcuProxy: From Target => " + data + "<===");
                }

                this.inCache += data.toString();

                // parse messages here
                // each message is an XML document
                // status messages are sent in a bubble right message of the form:
                // <xsbug><bubble name="" value="2" path="/Users/hoddie/Projects/moddable/examples/helloworld/main.js" line="18">JSON STATUS MESSAGE HERE</bubble></xsbug>

                // xsbug seems to be very sensitive to wrong formatted xml.
                // Thus this is the cache of sanitized xml, to be sent later to xsbug
                let for_xsbug = [];

                let end = -1;
                do {
                    let parse_error = false;

                    const start = this.inCache.indexOf("<xsbug>");
                    end = (start < 0) ? -1 : this.inCache.indexOf("</xsbug>", start);
                    
                    if (end > -1) {
                        const xml = this.inCache.slice(start, end + 8);
                        let doc;
                        try {                            
                            let parser = new XMLParser({
                                ignoreAttributes: false
                            });
                            doc = parser.parse(xml)
                        }
                        catch {
                            parse_error = true;
                        }

                        this.inCache = this.inCache.slice(end + 8);

                        // *****
                        // * This logic supports two mcu communication protocols!
                        // *
                        // * #1: status = { ...status, ...source}; node id provided as source.id
                        // *     This protocol has significant overhead, as only source.id will be processed further.
                        // *
                        // * #2: status = { ...status }; node id provided as bubble.name (!!)
                        // *     This protocol runs with less overhead but a bit more effort to extract the node id.
                        // *
                        // * #1 was the original protocol, #2 introduced in 11/22.
                        // ***** 

                        // Template @ fast-xml-parser
                        // {
                        //     xsbug: {
                        //         bubble: {
                        //         '#text': '{"state": "building"}',
                        //         '@_name': 'NR_EDITOR',
                        //         '@_value': '1',
                        //         '@_path': '[...]/nodered.js',
                        //         '@_line': '147'
                        //         }
                        //     }
                        // }

                        if (doc?.xsbug?.bubble) {
                            let bbl = doc.xsbug.bubble;

                            let id = bbl['@_name']?.length > 0 ? bbl['@_name'] : undefined;
                            let text = bbl['#text']?.length > 0 ? bbl['#text'] : undefined;

                            if (text) {
                                try {
                                    let msg = JSON.parse(text);

                                    if ("state" in msg) {
                                        this.emit("mcu", {state: msg["state"]});
                                    } else {
                                        let tags = ["status", "input", "error", "warn"];
                                        for (let i=0, l=tags.length; i<l; i++) {
                                            let t = tags[i];
                                            let m = msg[t];
    
                                            if (m) {
                                                id = id ?? m.source?.id ?? undefined;
                                                delete m.source;
                                                this.emit(t, id, m);
                                                break;
                                            }
                                        }
    
                                    }

                                } catch {
                                    parse_error = true;
                                }
                            }
                        } else if (doc?.xsbug?.login) {
                            
                            // Template @ fast-xml-parser
                            // { xsbug: { login: { '@_name': 'main', '@_value': 'XS' } } }

                            let login = doc.xsbug.login;
                            if (login['@_value']?.length > 0 && "XS" == login['@_value']) {
                                this.emit("mcu", {state: "login", from: login['@_name'] ?? ""});
                            }
                        }

                        if (!parse_error)
                            for_xsbug.push(xml);
                        
                    }
                } while (end >= 0);

                let prxy = this;
                for_xsbug.forEach(function(data) {
                    if (prxy.relay && prxy.xsbug) {
                        if (prxy.xsbug.deferred)
                            prxy.xsbug.deferred.push(data);
                        else
                            prxy.xsbug.write(data + "\r\n");
                    }
                    else {
                        if (first) {
                            // first time need to send set-all-breakpoints as xsbug does
                            first = false;
                            target.write('\r\n<set-all-breakpoints><breakpoint path="exceptions" line="0"/></set-all-breakpoints>\r\n');
                        }
                        else {
                            // assume any other messages are a break, so send go. This isn't always corrrect but may always work.
                            target.write('\r\n<go/>\r\n');
                        }
                    }    
                })

            });
            target.on('end', () => {
                if (this.trace)
                    console.log('mcuProxy: Target disconnected.');
                if (this.xsbug)
                    this.xsbug.destroy();
                    this.xsbug = undefined;
            });
            target.on("error", () => {
                // we should emit an error here...
            });
        });
        
        this.server.listen(this.portIn, () => { 
            let addr = this.server.address()
            console.log(`- Listening for MCU @ ${addr.address}:${addr.port}/${addr.family}`);
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
            catch (err) {
                console.log("Error sending command to MCU: " + err.message);
            }
		}
    }

    disconnect() {
        if (this.xsbug) {
            try {
                this.xsbug.destroy();
            } catch {}
        }
        this.xsbug = undefined;

        if (this.target) {
            try {
                this.target.destroy();
            } catch {}
        }
        this.target = undefined;

        if (this.server) {
            try {
                this.server.close();
                this.server.unref();
            } catch {}
        }
        this.server = undefined;

    }
}

module.exports = {
    proxy: mcuProxy
}
