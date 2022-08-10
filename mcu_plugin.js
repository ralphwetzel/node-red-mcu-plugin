const { exec } = require('node:child_process');
const fs = require('fs-extra');
const os = require("os");
const path = require("path");
const {SerialPort} = require("serialport");

const app_name = "node-red-mcu-plugin";
const build_cmd = "mcconfig -d -m -p mac"

const mcuProxy = require("./lib/proxy.js");

let flows2build = [];
let proxy;

let error_header = "*** Error while loading node-red-mcu-plugin:"

const mcu_plugin_config = {
//    "simulators": {},
    "cache_file": "",
    "cache_data": [],

    "platforms": [],
    "ports": []
}

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
    // File to persist plugin data
    function get_cache() {
        let cache_file = path.join(RED.settings.userDir, "mcu-plugin-cache", "cache.json");
        fs.ensureFileSync(cache_file);
        let cache_data;
        try {
            cache_data = fs.readFileSync(cache_file, 'utf8');
        } catch (err) {
            RED.log.error("node-red-mcu-plugin: Failed to open cache file @ " + cache_file);
        } finally {
            cache_data = (cache_data.length > 0) ? cache_data : "[]"
        }

        try {
            cache_data = JSON.parse(cache_data) || {};
        } catch (err) {
            RED.log.warn("node-red-mcu-plugin: Cache file corrupted @ " + cache_file);
        }

        mcu_plugin_config.cache_file = cache_file;
        mcu_plugin_config.cache_data = cache_data;

    }


    function persist_cache(data) {
        // console.log("persist_cache", data)
        if (!data) {
            data = mcu_plugin_config.cache_data;
        } else {
            mcu_plugin_config.cache_data = data;
        }
        // console.log("cache_data", mcu_plugin_config.cache_data);

        let cache_data = JSON.stringify(data);
        fs.writeFile(mcu_plugin_config.cache_file, cache_data, err => {
            if (err) {
                RED.log.warn("node-red-mcu-plugin: Failed to persist config to cache @ " + mcu_plugin_config.cache_file);
            }
        })
    }

    get_cache();

    // End: "File ..."
    // *****


    // *****
    // Collect some info regarding the MODDABLE toolkit

    // https://stackoverflow.com/questions/18112204/get-all-directories-within-directory-nodejs
    function getDirectories(parent_dir) {
        return fs.readdirSync(parent_dir).filter(function (file) {
            return fs.statSync(path.join(parent_dir,file)).isDirectory();
        });
      }

    const MODDABLE = process.env.MODDABLE

    {
        // Those are the available platforms we are aware of:
        let platform_identifiers = [
            'esp/8285',
            'esp/adafruit_oled',
            'esp/adafruit_st7735',
            'esp/buydisplay_ctp',
            'esp/crystalfontz_monochrome_epaper',
            'esp/esp8266_st7789',
            'esp/generic_square_huzzah',
            'esp/moddable_display_1',
            'esp/moddable_display_3',
            'esp/moddable_one',
            'esp/moddable_three',
            'esp/moddable_zero',
            'esp/nodemcu',
            'esp/sharp_memory',
            'esp/sharp_memory_square',
            'esp/sparkfun_teensyview',
            'esp/switch_science_reflective_lcd',
            'esp32/esp32_st7789',
            'esp32/esp32_thing',
            'esp32/esp32_thing_plus',
            'esp32/esp32c3',
            'esp32/esp32s3',
            'esp32/heltec_lora_32',
            'esp32/heltec_wifi_kit_32',
            'esp32/kaluga',
            'esp32/lilygo_t5s',
            'esp32/lilygo_ttgo',
            'esp32/m5atom_echo',
            'esp32/m5atom_lite',
            'esp32/m5atom_matrix',
            'esp32/m5core_ink',
            'esp32/m5paper',
            'esp32/m5stack',
            'esp32/m5stack_core2',
            'esp32/m5stack_fire',
            'esp32/m5stick_c',
            'esp32/moddable_display_2',
            'esp32/moddable_two',
            'esp32/moddable_two_io',
            'esp32/moddable_zero',
            'esp32/nodemcu',
            'esp32/oddwires',
            'esp32/saola_wroom',
            'esp32/saola_wrover',
            'esp32/wemos_oled_lolin32',
            'esp32/wrover_kit',
            'gecko/blue',
            'gecko/giant',
            'gecko/mighty',
            'gecko/thunderboard',
            'gecko/thunderboard2',
            'pico/captouch',
            'pico/ili9341',
            'pico/pico_display',
            'pico/pico_display_2',
            'pico/pico_lcd_1.3',
            'qca4020/cdb'
        ]

        let platforms = [];
        let platform_path = path.join(MODDABLE, "build", "devices");
        let platforms_verified = platform_identifiers.slice(0); // deep copy
        let p1 = getDirectories(platform_path);
        let opener = true;
        for (let i=0; i<p1.length; i+=1) {
            let target_path = path.join(MODDABLE, "build", "devices", p1[i], "targets");
            let p2 = getDirectories(target_path);
            for (let ii=0; ii<p2.length; ii+=1) {
                let p = p1[i]+"/"+p2[ii];
                let io = platforms_verified.indexOf(p);
                if (!(io < 0)) {
                    platforms_verified.splice(io,1);
                    platforms.push({value: p})
                } else {
                    if (opener) {
                        RED.log.info("*** node-red-mcu-plugin:");
                        RED.log.info("It looks as if a new platform option has been added.");
                        RED.log.info("Please raise an issue @ our GitHub repository, stating the following information:");
                        opener = false;
                    }
                    RED.log.info("> New platform:", p);
                }
            }
        }
        opener = true;
        for (let i=0; i<platforms_verified.length; i+=1) {
            if (opener) {
                RED.log.info("*** node-red-mcu-plugin:");
                RED.log.info("It looks as if a platform option has been removed.");
                RED.log.info("Please raise an issue @ our GitHub repository, stating the following information:");
                opener = false;
            }
            RED.log.info("> Verify platform:", platforms_verified[i]);
            platform_identifiers.splice(platform_identifiers.indexOf(platforms_verified[i]), 1);
        }
        // console.log(platform_identifiers);
        mcu_plugin_config.platforms = platforms;
    }

    {
        // Those are the available sims we are aware of:
        let simulator_identifiers = {
            'sim/m5paper': "M5Paper",
            'sim/m5stickc': "M5Stick",
            'sim/moddable_one': "Moddable One",
            'sim/moddable_two': "Moddable Two",
            'sim/moddable_three': "Moddable Three",     // this order looks better 
            'sim/nodemcu': "Node MCU",
            'sim/pico_display': "Pico Display",
            'sim/pico_display_2': "Pico Display2"
        };

        let platforms = mcu_plugin_config.platforms;
        let simulator_path = path.join(MODDABLE, "build", "simulators");
        let sims_verified = Object.keys(simulator_identifiers);
        p1 = getDirectories(simulator_path);
        let opener = true;
        for (let i=0; i<p1.length; i+=1) {
            let id = "sim/"+p1[i];
            if (p1[i] !== "modules") {
                if (!simulator_identifiers[id]) {
                    if (opener) {
                        RED.log.info("*** node-red-mcu-plugin:");
                        RED.log.info("There seems to be an additional simulator option available.");
                        RED.log.info("Please raise an issue @ our GitHub repository, stating the following information:");
                        opener = false;    
                    }
                    RED.log.info("> New simulator:", id);
                } else {
                    sims_verified.splice(sims_verified.indexOf(id), 1);
                    platforms.push({value: id, label: simulator_identifiers[id]})
                }
            }
        }

        opener = true;
        for (let i=0; i<sims_verified.length; i+=1) {
            if (opener) {
                RED.log.info("*** node-red-mcu-plugin:");
                RED.log.info("It looks as if a simulator option has been removed.");
                RED.log.info("Please raise an issue @ our GitHub repository, stating the following information:");
                opener = false;
            }
            RED.log.info("> Verify simulator:", sims_verified[i]);
            delete simulator_identifiers[sims_verified[i]];
        }

        // console.log(simulator_identifiers);
        mcu_plugin_config.platforms = platforms;
    }

    // End "Collect ..."
    // *****

    // *****
    // The serial port scanner
    function refresh_serial_ports(repeat) {
        SerialPort.list()
        .then( (p) => {
            let ports = [];
            for (let i=0; i<p.length; i+=1) {
                if (p[i].path && p[i].path.length > 0) {
                    ports.push(p[i].path);
                }
            }
            ports.sort();
            
            mcu_plugin_config.ports = ports;

            // ToDo: Check why the message is received several (==3) times at the client side?!
            RED.comms.publish("mcu/serialports",  ports, false);

            setTimeout(refresh_serial_ports, repeat, repeat);
        })
    }

    refresh_serial_ports(5000);

    // End: "The serial..."
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
            "./node-red-mcu/nodered.c": "./nodered.c",
            "./node-red-mcu/nodes": "./nodes"
        }
        
        // make the flows.js file
        /*
        let nodes = [];
        RED.nodes.eachNode(function(n) {
            if (n._mcu) {
                nodes.push(n);
            }
        });
        let flowsjs = "const flows=" + JSON.stringify(nodes, null, 2) + ";\r\n";
        flowsjs+= "export default Object.freeze(flows, true);"
        */

        // make the flows.json file
        let nodes = [];
        RED.nodes.eachNode(function(n) {
            if (n._mcu) {
                nodes.push(n);
            }
        });

        // in case this is going to be changed again ;)
        let flows_file_data = JSON.stringify(nodes, null, 2)
        let flows_file_name = "flows.json"

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
    
        fs.writeFileSync(path.join(dest, flows_file_name), flows_file_data, (err) => {
            if (err) {
                throw err;
            }
        });

        return dest;
    
    }

    function build_and_run(publish, options) {

        options = options || {};
        let cmd = "mcconfig"

        if (options.debug === true) {
            cmd += " -d";
            cmd += " -x localhost:5004"
        }

        if (options.pixel) {
            cmd += " -f " + options.pixel;
        }

        if (options.release === true) {
            cmd += " -i"
        }

        if (options.make === true) {
            cmd += " -m";
        }

        if (options.platform) {
            cmd += " -p " + options.platform;
        }

        if (options.rotation) {
            cmd += " -r " + options.rotation;
        }

        if (options.buildtarget) {
            cmd += " -t " + options.buildtarget;
        }

        if (options.arguments) {

            let args = JSON.parse(options.arguments)
            for (key in args) {
                cmd += " " + key + '="' + args[key] + '"'
            }
        }

        return new Promise((resolve, reject) => {

            let msg = {};
            let error;
    
            try {
                let make_dir = make_build_environment();
                // console.log(make_dir);
                
                // RDW 20220805: obsolete now
                // patch_xs_file("5002", "5004");
                
                publish("mcu/stdout/test",  "cd " + make_dir, false); 
                publish("mcu/stdout/test",  cmd, false); 

                let builder = exec(cmd, {
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

                    // RDW 20220805: obsolete now
                    /*
                    try {
                        patch_xs_file("5004", "5002");
                    }
                    catch (error) {
                        if (!msg.error) {
                            msg.error = {};
                        }
                        msg.error['patch_error'] = error; 
                    }
                    */

                    if (msg.error) {
                        reject(msg)
                    }

                    resolve(msg);
                });

                builder.stdout.on('data', function(data) {
                    publish("mcu/stdout/test", data, false); 
                });
                builder.stderr.on('data', function(data) {
                    publish("mcu/stdout/test", data, false); 
                });

            } catch (err) {
                console.log("@catch (err)")
                msg.error = {};
                for (e in err) {
                    msg.error[e] = err[e];
                }
    
                // RDW 20220805: obsolete now
                /*
                try {
                    patch_xs_file("5004", "5002");
                }
                catch (error) {
                    if (!msg.error) {
                        msg.error = {};
                    }
                    msg.error['patch_error'] = error; 
                }
                */

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
                        // console.log(data);

                        console.log("Building NOW the MCU App.")

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

            RED.httpAdmin.post(`${apiRoot}/build`, routeAuthHandler, (req, res) => {
                
                console.log("@manual_build")

                let build_options = req.body.options
                if (!build_options) {
                    res.status(400).end();
                    return;
                }

                // *** Is this a valid assumption?
                if (!build_options.make) {
                    build_options.make = true;
                }
                // ***

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
        
                    console.log(data);

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
        
                    // console.log("Status:", status);
                })

                // build_and_run()
                // .then(msg => { console.log(msg) })
                // .catch(msg => {console.log("error @ build_and_run", msg)});

                return build_and_run(RED.comms.publish, build_options)
                .then((msg) => {
                    // console.log("after build", msg)
                    if (msg.error) {
                        res.status(500).end();
                    } else {
                        res.status(200).end();
                    }
                })
                .catch((err) => {
                    // RED.comms.publish("mcu/stdout/test", "__flash_console", true)
                    res.status(400).end();
                })

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


            RED.httpAdmin.get(`${apiRoot}/config`, routeAuthHandler, (req, res) => {
                // console.log("cache_data", mcu_plugin_config.cache_data)
                let c = {
                    "config": mcu_plugin_config.cache_data
                }
                // refresh_serial_ports();
                res.status(200).end(JSON.stringify(c), "utf8")
            })

            RED.httpAdmin.get(`${apiRoot}/config/plugin`, routeAuthHandler, (req, res) => {
                let c = {
                    // "simulators": mcu_plugin_config.simulators,
                    "platforms": mcu_plugin_config.platforms,
                    "ports": mcu_plugin_config.ports
                }
                res.status(200).end(JSON.stringify(c), "utf8")
            })

            /*
            RED.httpAdmin.get(`${apiRoot}/config/ports`, routeAuthHandler, (req, res) => {
                let c = {
                    "ports": mcu_plugin_config.ports,
                }
                // refresh_serial_ports();
                res.status(200).end(JSON.stringify(c), "utf8")
            })
            */

            RED.httpAdmin.post(`${apiRoot}/config`, routeAuthHandler, (req, res) => {
                // console.log(req.body);
                let config;
                if (req.body && req.body.config) {
                    config = req.body.config;
                } else {
                    RED.log.error("node-red-mcu-plugin: Failed to parse incoming config data.");
                    res.status(400).end();
                    return;
                }
                persist_cache(config);
                res.status(200).end();    
            })
            

/*
            RED.httpAdmin.get(`${apiRoot}/test`, routeAuthHandler, (req, res) => {
                // res.json(flowDebugger.getBreakpoints());
                console.log("test.")
            })
*/            
        }
    });
    
}