class MessageRelay {

    constructor(RED) {
        this.RED = RED;
    }

    #getNode(id) {
        return this.RED.nodes.getNode(id);
    }

    status(id, data) {

        /* {
            text: 1658087621772,
            source: { id: '799b7e8fcf64e1fa', type: 'debug', name: 'debug 4' }
        } */

        let status = {};

        let fill = data.fill;
        let shape = data.shape;
        let text = data.text;

        if (fill) { status["fill"] = fill;}
        if (shape) { status["shape"] = shape;}
        if (text) { status["text"] = text;}

        if (this.#getNode(id)) {
            this.RED.events.emit("node-status",{
                "id": id,
                "status": status
            });    
        }

    }

    input(id, data) {
        if (id)
            this.#getNode(id)?.receive(data);
    }

    error(id, data) {
        if (id)
            this.#getNode(id)?.error(data.error);
    }

    warn(id, data) {
        if (id)
            this.#getNode(id)?.warn(data.warn);
    }

    mcu(data) {

        let MCU_EXPERIMENTAL = process.env['MCU_EXPERIMENTAL'];

        // as the standard interface is (id, data)
        // we accept data as the second argument as well - if the first is undefined.

        if (arguments.length > 1) {
            if (!arguments[0]) {
                data = arguments[1]
            }
        }


        let msg;
        let options;

        switch (data.state) {
            case "login":

                let from = data.from
                if (from.length > 0) {
                    if (from === "main") {
                        msg = "MCU is initializing...";
                    } else if (from.length > 6) {
                        let c = from.substring(0, 6);
                        let c_id = from.substring(6);
                        if (c === "config" && c_id == options.id) {
                            msg = "Simulator is initializing...";
                        }
                    }
                }

                options = { type: "warning", timeout: 5000 };
                break;
            
            // reset node status
            // In case we ever support more than one MCU instance running in parallel,
            // we need a more precise way to select the affected nodes.
            case "abort":
                // this affects only nodes having the reset_status flag set in _mcu
                // Att: this flag is set only (!) in the runtime representation => getNode
                this.RED.nodes.eachNode((n) => {
                    if (n._mcu?.mcu) {
                        let nn = this.RED.nodes.getNode(n.id);
                        if (nn?._mcu?.reset_status_on_abort) {
                            this.RED.events.emit("node-status",{
                                "id": n.id,
                                "status": {}
                            });    
                        }
                    }
                })
                break;

            case "building":
                // this affects all mcu nodes!
                console.log("@building");
                this.RED.nodes.eachNode((n) => {
                    if (n._mcu?.mcu) {
                        this.RED.events.emit("node-status",{
                            "id": n.id,
                            "status": {}
                        }); 
                    }
                })
                break;

            case "ready":
                
                // building & ready fire almost simultaneously
                msg = "Flows are ready.";
                options = { timeout: 5000 };
                break;

            case "mod_waiting":
                console.log("@mod_waiting");
                if (MCU_EXPERIMENTAL & 1) {
                    msg = "Host is ready. Waiting for flows to be installed.";
                    options = { timeout: 5000 };
                    break;    
                }

            case "mod_ui_missing":
                if (MCU_EXPERIMENTAL & 1) {
                    const notif = RED.notify(
                        "This flow uses UI nodes, yet the host was build without UI support.<br>Please ensure that UI Support is enabled, rebuild & install the host, then rebuild this flow.",
                        options = {
                            type: "error",
                            modal: true,
                            buttons:  [
                                {
                                    text: "OK",
                                    click: function(e) {
                                        notif.close();
                                    }
                                },
                            ]
                        }
                    );
                    break;    
                }

            default:
                return;

        }

        if (msg && msg.length > 0) {
            console.log("@mcu_notify");
            this.RED.comms.publish("mcu/notify",  {
                "message": msg, 
                "options": options
            });    
        }

    }

}

module.exports = {
    relay: MessageRelay
}