const { exec } = require('node:child_process');
const fs = require('fs-extra');
const os = require("os");
const path = require("path");

const app_name = "node-red-mcu-plugin";
const build_cmd = "mcconfig -d -m -p mac"

const mcuProxy = require("./lib/proxy.js");

let flows2build = [];
let proxy;

let error_header = "*** Error while loading node-red-mcu-plugin:"

module.exports = function(RED) {

    // *****
    // Hook node definitions

    function mcu_inject(config) {
        RED.nodes.createNode(this, config);
        let node = this;
        node.on('input', function(msg, send, done) {

            if (proxy) {
                proxy.send2mcu("inject", this.z, this.id);
            }
            return;
        });
    }
    RED.nodes.registerType("mcu*inject",mcu_inject);


    // End "Hook ..."
    // *****


    // *****
    // Calculate path to flowUtil (lib/flows/util.js" & require it
    let rm = require.main.path;

    try {
        let stat = fs.lstatSync(rm);
        if (!stat.isDirectory()) {
            console.log(error_header);
            console.log("require.main.path is not a directory.");
            return;
        }
    } catch (err) {
        console.log(error_header);
        if (error_header.code == 'ENOENT') {
            console.log("require.main.path not found.");
        } else {
            console.log("Error while handling require.main.path.")
        }
        return;
    }

    // split path into segments ... the safe way
    rm = path.normalize(rm);
    let rms = []
    let rmp;
    do {
        rmp = path.parse(rm);
        if (rmp.base.length > 0) {
            rms.unshift(rmp.base);
            rm = rmp.dir;    
        }
    } while (rmp.base.length > 0)

    let rmsl = rms.length;

    if (rms.includes("packages"))  {
        if (rms[rmsl-3]=="packages" && rms[rmsl-2]=="node_modules" && rms[rmsl-1]=="node-red") {
            // dev:     [...]/node-red/packages/node_modules/node-red
            // install: [...]/lib/node_modules/node-red
            // pi:      /lib/node_modules/node-red/

            // dev:     [...]/node-red/packages/node_modules/@node-red
            // install: [...]/lib/node_modules/node-red/node_modules/@node-red
            // pi:      /lib/node_modules/node-red/node_modules/@node-red
            rms.splice(-2);
        }
    }

    // compose things again...
    let p = path.join(rmp.root, ...rms,"node_modules", "@node-red","runtime","lib", "flows", "util.js");

    if (!fs.existsSync(p)) {
        console.log(error_header)
        console.log("Failed to calculate correct patch path.");
        console.log("Please raise an issue @ our GitHub repository, stating the following information:");
        console.log("> require.main.path:", require.main.path);
        console.log("> utils.js:", p);
        return;
    }

    let flowUtil = require(p)

    // End "Calculate ..."
    // *****

    // *****
    // Apply a patch to hook into the node creation process of the runtime.

    let orig_createNode = flowUtil.createNode;
    function patched_createNode(flow,config) {

       // console.log("@patch");

        // console.log(config);

        // replacement table NR=>MCU
        let replace = {
            'inject': 'mcu*inject',
        }

        /*
        if (flows2build) {
            for (let i=0; i<flows2build.length; i+=1) {
                if (config.z === flows2build[i]) {

                    if (config.type && replace[config.type]) {
                        config.type = replace[config.type]
                        console.log("replacing " + config.id)
                        break;
                    }

                    // if no replacement node defined: Don't create any node!
                    console.log("voiding " + config.id)
                    return;
                }
            }    
        }
*/

        if (config._mcu && config._mcu===true) {
            console.log("@mcu");
            if (config.type && replace[config.type]) {
                config.type = replace[config.type]
                console.log("replacing " + config.id)
            } else {
                // if no replacement node defined: Don't create any node!
                console.log("voiding " + config.id)
                return;
            }
        }

        return orig_createNode(flow,config);
    }

    let orig_diffConfigs = flowUtil.diffConfigs;
    function patched_diffConfigs(oldConfig, newConfig) {
        
        // console.log(oldConfig, newConfig);
        
        let res = orig_diffConfigs(oldConfig, newConfig);
        console.log("diffConfigs", res);
        return res;
    }

    let orig_diffNodes = flowUtil.diffNodes;
    function patched_diffNodes(oldNode,newNode) {

        let res = orig_diffNodes(oldNode,newNode);
        console.log("diffNodes", res);
        return res;
    }

    
    
    // console.log("patching flowUtil")
    flowUtil.createNode = patched_createNode;
    flowUtil.diffNodes = patched_diffNodes;
    flowUtil.diffConfigs = patched_diffConfigs;

    // console.log(flowUtil.diffNodes.toString());


    // End "Apply..."
    // *****

    // *****
    function patch_xs_file(pre, post) {

        let moddable = process.env.MODDABLE
        
        if (moddable) {
            let os_file = {
                "darwin": "mac_xs.c"
            }
    
            let xs_file_path = path.join(moddable, 'xs', 'platforms', os_file[process.platform]);
            let xs_file = fs.readFileSync(xs_file_path).toString();
            let check_pre = "address.sin_port = htons(" + pre + ");";
            let check_post = "address.sin_port = htons(" + post + ");";
            if (xs_file.indexOf(check_pre) > 0) {
                xs_file = xs_file.replace(check_pre, check_post);
            }
            if (xs_file.indexOf(check_post) < 0) {
                throw "Failed to patch platform specific debug connection.";
            } else {
                console.log("Patch success confirmed @ " + post + ".");
                fs.writeFileSync(xs_file_path, xs_file);
            }
        } else {
            throw "Cannot proceed. $MODDABLE is not defined.";
        }
        return;
    }
    // *****

    // *****
    // The plugin

    const apiRoot = "/mcu";
    const routeAuthHandler = RED.auth.needsPermission("mcu.write");
    console.log("MCU loaded.")




    function make_build_environment() {

        // file to copy to generate the build environment
        const env4build = {
            "./node-red-mcu/main.js": "./main.js", 
            "./node-red-mcu/manifest.json": "./manifest.json",
            "./node-red-mcu/nodered.js": "./nodered.js",
            "./node-red-mcu/nodes": "./nodes"
        }
        
        // make the flows.js file
        let nodes = [];
        RED.nodes.eachNode(function(n) {
            if (n._mcu) {
                nodes.push(n);
            }
        });
        let flowsjs = "const flows=" + JSON.stringify(nodes, null, 2) + ";\r\n";
        flowsjs+= "export default Object.freeze(flows, true);"
        
        let error;
        let dest = fs.mkdtempSync(path.join(os.tmpdir(), app_name));
    
        fs.ensureDirSync(dest);
        for (let file in env4build) {
            let source = path.join(__dirname, file);
            let target = path.join(dest, env4build[file]);
            let stat = fs.statSync(source);
            if (stat.isDirectory()) {
                fs.emptyDirSync(target);
            }
            fs.copySync(source,target);
        }
    
        fs.writeFileSync(path.join(dest, 'flows.js'), flowsjs, (err) => {
            if (err) {
                throw err;
            }
        });

        return dest;
    
    }

    function build_and_run() {

        return new Promise((resolve, reject) => {

            let msg = {};
            let error;
    
            try {
                let make_dir = make_build_environment();
                console.log(make_dir);
                
                patch_xs_file("5002", "5004");
    
                exec(build_cmd, {
                    cwd: make_dir,
                }, (err, stdout, stderr) => {
            
                    if (err) {
                        msg.error = {};
                        for (e in err) {
                            msg.error[e] = err[e];
                        }
                    }
                    
                    msg.exec = {};
                    msg.exec.stdout = stdout;
                    msg.exec.stderr = stderr;
    
                    // console.log(msg);

                    try {
                        patch_xs_file("5004", "5002");
                    }
                    catch (error) {
                        if (!msg.error) {
                            msg.error = {};
                        }
                        msg.error['patch_error'] = error; 
                    }
                    
                    if (msg.error) {
                        reject(msg)
                    }

                    resolve(msg);
                })
            } catch (err) {
                console.log("@catch (err)")
                msg.error = {};
                for (e in err) {
                    msg.error[e] = err[e];
                }
    
                try {
                    patch_xs_file("5004", "5002");
                }
                catch (error) {
                    if (!msg.error) {
                        msg.error = {};
                    }
                    msg.error['patch_error'] = error; 
                }    

                console.log("Error:", msg);

                console.log("@reject")
                reject(msg);
    
            }
        })
    }
    
    RED.plugins.registerPlugin("node-red-mcu", {
        onadd: () => {
            console.log("MCU added.")

            RED.httpAdmin.post(`${apiRoot}/flows2build`, routeAuthHandler, (req, res) => {
                if (req.body && req.body.flows2build) {
                    flows2build = req.body.flows2build;
                }
                res.status(200).send('OK');
            });

            RED.events.on("runtime-event", function(data) {
                return;
                if (data && data.payload) {
                    if (data.payload.state === "start" && data.payload.deploy === true) {
                        console.log(data);

                        console.log("Building NOW the MCU App.")

                        // create the proxy to the MCU / Simulator
                        if (proxy) {
                            proxy.disconnect();
                            delete proxy;
                        }
                        console.log(mcuProxy);

                        proxy = new mcuProxy.proxy();

                        proxy.on("status", (data) => {

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
                
                            if (data.source && data.source.id) {
                                console.log("Emitting to " + data.source.id);
                                RED.events.emit("node-status",{
                                    "id": data.source.id,
                                    "status": status
                                });    
                            }
                
                            console.log("Status:", status);
                        })

                        let msg = build_and_run();
                        console.log(msg);

                    }
                }
            });

            RED.httpAdmin.put(`${apiRoot}/build`, routeAuthHandler, (req, res) => {
                
                console.log("@manual_build")

                // create the proxy to the MCU / Simulator
                if (proxy) {
                    proxy.disconnect();
                    delete proxy;
                }
                // console.log(mcuProxy);

                proxy = new mcuProxy.proxy();

                proxy.on("status", (data) => {

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
        
                    if (data.source && data.source.id) {
                        // console.log("Emitting to " + data.source.id);
                        RED.events.emit("node-status",{
                            "id": data.source.id,
                            "status": status
                        });    
                    }
        
                    // console.log("Status:", status);
                })

                // build_and_run()
                // .then(msg => { console.log(msg) })
                // .catch(msg => {console.log("error @ build_and_run", msg)});

                return build_and_run()
                .then((msg) => {
                    console.log("after build", msg)
                    if (msg.error) {
                        res.status(500).end();
                    } else {
                        res.status(200).end();
                    }
                })/*
                .catch((err) => {
                    console.log("Promise:", err);
                })*/

                /*
                    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), app_name));
  
                    exec("mcconfig -d -m -p mac", {
                        cwd: tmpDir
                    }, (error, stdout, stderr) => {
                        if (error) {
                            res.status(500).send(error.message);
                        } else {
                            res.status(200).send('OK');
                        }
                        // console.log(stdout);
                        // console.error(stderr);
                      });
                }
                finally {
                    try {
                        if (tmpDir) {
                          fs.rmSync(tmpDir, { recursive: true });
                        }
                      }
                    catch (e) {}
                }
*/
                // console.log("MCU -> build");
                //res.sendStatus(200);
            });



/*
            RED.httpAdmin.get(`${apiRoot}/test`, routeAuthHandler, (req, res) => {
                // res.json(flowDebugger.getBreakpoints());
                console.log("test.")
            })
*/            
        }
    });
    
}