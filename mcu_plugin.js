const clone = require("clone");
const { exec } = require('node:child_process');
const fs = require('fs-extra');
const os = require("os");
const path = require("path");
const {SerialPort} = require("serialport");

const app_name = "node-red-mcu-plugin";
const build_cmd = "mcconfig -d -m -p mac"

const mcuProxy = require("./lib/proxy.js");
const mcuNodeLibrary = require("./lib/library.js");
const mcuManifest = require("./lib/manifest.js");

// const {getPersistentShell} = require('./lib/persistent-shell');

// https://github.com/stefanpenner/resolve-package-path
const resolve_package_path = require('resolve-package-path')

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

const library = new mcuNodeLibrary.library();
global.registerMCUModeType = function(standard_type, mcumode_type) {
    library.register_mcumode_type(standard_type, mcumode_type)
}

let runtime_nodes;

// ****
// Patch support function: Calculate the path to a to-be-required file

function get_require_path(req_path) {

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
        return null;
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
    req_path = req_path.split("/");
    let p = path.join(rmp.root, ...rms, ...req_path);

    if (!fs.existsSync(p)) {
        console.log(error_header)
        console.log("Failed to calculate correct patch path.");
        console.log("Please raise an issue @ our GitHub repository, stating the following information:");
        console.log("> require.main.path:", require.main.path);
        console.log("> utils.js:", p);
        return null;
    }

    return p;
}

// End: "Patch support ..."
// *****

// *****
// Apply patch to get access to additional node related information
// This has to happen immediately when this file is required, before any Node-RED logic kicks in...

const registryUtilPath = get_require_path("node_modules/@node-red/registry/lib/util.js")
if (!registryUtilPath) return;

const registryUtil = require(registryUtilPath)

const orig_createNodeApi = registryUtil.createNodeApi;
function patched_createNodeApi(node) {

    if (node.file.indexOf("mcu_plugin.js") >= 0) {
        // console.log(node.namespace, node.file, node.id)
        // console.log(node);
    } else {
        if (node.types) {
            library.register_node(node);
        }
        // console.log(node.namespace, node.file, node.id)
    }

    // console.log(node.file);
    return orig_createNodeApi(node);
}
registryUtil.createNodeApi = patched_createNodeApi


// *** THIS DOESNT WORK!!
// We use this patch to get our hand on the full runtime.nodes API
let orig_copyObjectProperties = registryUtil.copyObjectProperties;
console.log(orig_copyObjectProperties);

function patched_copyObjectProperties(src,dst,copyList,blockList) {

    if (!runtime_nodes && copyList.indexOf("createNode") >=0 && copyList.indexOf("getNode") >=0) {
        runtime_nodes = src;
        console.log(runtime_nodes);
    }

    return orig_copyObjectProperties(src,dst,copyList,blockList);
}
registryUtil.copyObjectProperties = patched_copyObjectProperties;

//
// *****


module.exports = function(RED) {

    console.log(process.env);

    // *****
    // env variable settings: Ensure ...
    
    let IDF_PATH;

    // ... that $MODDABLE is defined.
    const MODDABLE = process.env.MODDABLE;
    
    if (!MODDABLE) {
        RED.log.error("*** node-red-mcu-plugin -> Error:");
        RED.log.error("* Environment variable $MODDABLE is not defined.");
        RED.log.error("* Please install the Moddable SDK according to its Getting Started Guide:");
        RED.log.error("* https://github.com/Moddable-OpenSource/moddable/blob/public/documentation/Moddable%20SDK%20-%20Getting%20Started.md");
        RED.log.error('* In addition please be aware that, when running Node-RED as a service (e.g. on Linux),');
        RED.log.error('* "it will not have access to environment variables that are defined only in the calling process."');
        RED.log.error('* Please refer to https://nodered.org/docs/user-guide/environment-variables#running-as-a-service for further support.');
        RED.log.error("*** node-red-mcu-plugin -> Runtime setup canceled.");
        return;
    }

    // ... that $MODDABLE declares a valid path.
    if (!fs.existsSync(MODDABLE)) {
        RED.log.error("*** node-red-mcu-plugin -> Error!");
        RED.log.error("* Environment variable $MODDABLE is stating a non-existing path:");
        RED.log.error(`* process.env.MODDABLE = "${MODDABLE}"`);
        RED.log.error("*** node-red-mcu-plugin -> Runtime setup canceled.");
        return;
    }

    // ... that the Moddable tools directory is included in $PATH.
    {
        const platform_modifier = {
            darwin: "mac",
            linux: "lin",
            win32: "win"
        }

        let pm = platform_modifier[process.platform];
        if (!pm) {
            RED.log.error("*** node-red-mcu-plugin -> Error!");
            RED.log.error("* Running on a platform not supported:");
            RED.log.error(`* process.platform = "${process.platform}"`);
            RED.log.error("*** node-red-mcu-plugin -> Runtime setup canceled.");
            return;
        }

        let moddable_tools_path = path.join(MODDABLE, "build", "bin", pm, "release");

        if (process.env.PATH.indexOf(moddable_tools_path) < 0) {
            process.env.PATH += (process.platform === "win32" ? ";" : ":") + moddable_tools_path;
        }
    }


    // ...that $IDF_PATH is defined

    // const IDF_PATH = process.env.IDF_PATH;

    // if (!IDF_PATH) {
        
    //     // Try to find IDF_PATH

    //     // ToDo: This is valid (confirmed) only for ESP32 & Linux.
    //     // Implement/confirm for the other targets & platforms (mac, win) as well!

    //     let HOME = process.env.HOME;
    //     if (HOME) {
    //         let idf_options = [
    //             `${HOME}/esp32/esp-idf`,
    //             `${HOME}/.local/share/esp32/esp-idf`
    //         ]
    
    //         for (let i=0; i<idf_options.length; i+=1) {
    //             if (fs.existsSync(idf_options[i])) {
    //                 process.env.IDF_PATH = idf_options[i];
    //             }
    //         }
    //     }
    // }

    // if (!IDF_PATH) {
    //     RED.log.error("*** node-red-mcu-plugin -> Error!");
    //     RED.log.error("* Environment variable $IDF_PATH is not defined.");
    //     RED.log.error("* Please refer to our documentation for further support.");
    //     RED.log.error("*** node-red-mcu-plugin -> Runtime setup canceled.");
    //     return;
    // }

    // // ... that $IDF_PATH declares a valid path.
    // if (!fs.existsSync(IDF_PATH)) {
    //     RED.log.error("*** node-red-mcu-plugin -> Error!");
    //     RED.log.error("* Environment variable $IDF_PATH is stating a non-existing path:");
    //     RED.log.error(`* process.env.IDF_PATH = "${IDF_PATH}"`);
    //     RED.log.error("*** node-red-mcu-plugin -> Runtime setup canceled.");
    //     return;
    // }
    
    // End: "env variable settings ..."
    // *****

    // *****
    // Hook node definitions

    function mcu_inject(config) {
        RED.nodes.createNode(this, config);
        let node = this;
        node.on('input', function(msg, send, done) {

            console.log("@input")
            if (proxy) {
                proxy.send2mcu("inject", this.z, this.id);
            }
            return;
        });
    }
    RED.nodes.registerType("__mcu*inject", mcu_inject);
    registerMCUModeType("inject", "__mcu*inject")

    function mcu_debug(config) {
        RED.nodes.createNode(this, config);
        console.log(config);

        let node = this;
        node.on('input', function(msg, send, done) {

            console.log("@mcu*debug", msg);

        });
    }
    RED.nodes.registerType("__mcu*debug", mcu_debug);
    registerMCUModeType("debug", "debug")

    // End "Hook ..."
    // *****


    // *****
    // Calculate path to flowUtil (lib/flows/util.js" & require it

    let flowUtilPath = get_require_path("node_modules/@node-red/runtime/lib/flows/util.js")
    if (!flowUtilPath) return;

    let flowUtil = require(flowUtilPath)

    // End "Calculate ..."
    // *****

    // *****
    // Apply a patch to hook into the node creation process of the runtime.


    function getProxy() {
        if (proxy) return proxy;
    }

    let orig_createNode = flowUtil.createNode;
    function patched_createNode(flow,config) {

       // console.log("@patch");

        // console.log(config);

        // replacement table NR=>MCU
        let replace = {
            'inject': '__mcu*inject',
            'debug': 'debug'
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

        let orig_type = config.type;

        if (config._mcu?.mcu === true) {
            console.log("@mcu");
            if (config.type) {
                let t = library.get_mcumode_type(config.type)
                console.log(t);
                if (t) {
                    config.type = t;
                    console.log("replacing " + config.id + " w/ " + t)
                } else {
                    // if no replacement node defined: Don't create any node!
                    console.log("voiding " + config.id)
                    return;
                }
            }
        }

        let node = orig_createNode(flow, config);

        // give mcu replacement nodes access to the proxy
        if (config.type !== orig_type) {
            node.__getProxy = getProxy;
        }

        return node;
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
            'esp32/c3_32s_kit',
            'esp32/c3_32s_kit_2m',
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
            'pico/itsybitsy',
            'pico/lilygo_t_display',
            'pico/pico_display',
            'pico/pico_display_2',
            'pico/pico_lcd_1.3',
            'pico/pico_w',
            'pico/picosystem',
            'pico/pro_micro',
            'pico/qtpy',
            'pico/tiny2040',
            'pico/xiao_rp2040',
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
                    RED.log.info(`> New platform: ${p}`);
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


    function make_build_environment(working_directory, options) {

        // Create target directory
        let dest = working_directory ?? fs.mkdtempSync(path.join(os.tmpdir(), app_name));
        fs.ensureDirSync(dest);


        let mainjs = [
            // 'import Modules from "modules";',
            // 'globalThis.Modules = Modules;',
            // 'globalThis.require = Modules.importNow;',
            // 'function require(_path) {',
            // 'trace("@require")',
            // '}',
            // 'globalThis.require = require;',
            'import "nodered";	// import for global side effects',
            // 'trace("pre", "\\n");',
        ];
        let mainjs_end = [
            'import flows from "flows";',
            // 'trace("post", "\\n");',
            'RED.build(flows);',
        ]

        
        // // write manifest_flows.json
        // // to compensate for the situation that we cannot - currently - opt-out the flows.json in the node-red-mcu directory
        // mf = {
        //     "modules": {
        //         "*": [{ 
        //                 "source": "./flows",
        //                 "transform": "nodered2mcu"
        //             }]
        //     }
        // }

        // fs.writeFileSync(path.join(dest, "manifest_flows.json"), JSON.stringify(mf, null, "  "), (err) => {
        //     if (err) {
        //         throw err;
        //     }
        // });

        // Create and initialize the manifest builder
        let mcu_nodes_root = path.resolve(__dirname, "./mcu_modules");
        // console.log(mcu_nodes_root);
        let manifest = new mcuManifest.builder(library, mcu_nodes_root);
        manifest.initialize();

        manifest.resolver_paths = [
            require.main.path,
            RED.settings.userDir
        ]

        // Try to make this the first entry - before the includes!

        // Add our flows.json
        // manifest.add_module({"source": "./flows", "transform": "nodered2mcu"})
        // manifest.include_manifest("./manifest_flows.json");

        // Add MODULES build path
        const mbp = path.resolve(MODDABLE, "./modules");
        manifest.add_build("MODULES", mbp);

        // Add root manifest from node-red-mcu
        // ToDo: node-red-mcu shall be a npm package as well - soon!
        const root_manifest_path = "./node-red-mcu"
        let rmp = path.resolve(__dirname, root_manifest_path);
        manifest.add_build("MCUROOT", rmp);
        manifest.include_manifest("$(MCUROOT)/manifest_runtime.json")

        // manifest.add_module("$(MCUROOT)/main")

        // manifest.include_manifest("./manifest_flows.json");

        // Make the flows.json file & add manifests of the nodes
        let nodes = [];
        let configNodes = {};

        // identify the nodes flagged with _mcu & as well the config nodes
        RED.nodes.eachNode(function(nn) {

            // the "official" test for a config node
            if (!nn.hasOwnProperty('x') && !nn.hasOwnProperty('y')) {
                configNodes[nn.id] = { "node": clone(nn) };
            }

            if (nn._mcu?.mcu === true) {

                let n = clone(nn);

                if (n.type == "tab" && n._mcu?.manifest?.trim?.().length>0) {
                    // Write the flow's manifest.json
                    fs.writeFileSync(path.join(dest, `manifest_${n.id}.json`), n._mcu.manifest.trim(), (err) => {
                        if (err) {
                            throw err;
                        }
                    });
                    manifest.include_manifest(`./manifest_${n.id}.json`)
                }

                let running_node = RED.nodes.getNode(n.id);
                running_node?.emit("build4mcu", n, manifest);

                // add node to flows.json
                nodes.push(n);
            }
        });

        /***** 
         * Resolve junction node connections to target nodes.
         * 
         * This could affect the total number of connection per output.
         * This code as well gets rid of circular references ... in case someone tries to play with the engine ;)
        */

        let resolver_cache = {};

        // initialize the resolver cache
        nodes.forEach(function(n) {
            resolver_cache[n.id] = n;
        })

        function resolve_junction_wire(dest, path) {

            // console.log("...", dest, path);
            
            function getNode(id) {

                // first check the resolver cache
                let node = resolver_cache[id];
                
                if (!node) {

                    // try to get running instance of this id
                    let n = RED.nodes.getNode(id);
    
                    if (!n) {
                        // That's sh** !
                        console.log(`Junction Resolver: Couldn't get node definition for #${id}.`)
                        return;
                    }
    
                    // create representation
                    node = {
                        "id": id,
                        "type": n.type
                    }
    
                    if (n.wires) {
                        node['wires'] = clone(n.wires);
                    }
    
                    resolver_cache[id] = node;
                }

                return node;
            }

            let node = getNode(dest);

            if (!node) return;
            if (node.type !== "junction") {
                // console.log("=> ", dest, "!");
                return [dest];
            }

            // node IS (!) a junction; continue resolving!
            
            if (node.wires.length == 0) {
                return;
            }

            let selfpath = path ? new Set([...path]) : new Set();
            selfpath.add(dest);

            // shall exactly have one output!
            if (node.wires.length == 0) {
                return;     // doesn't hurt
            } else if (node.wires.length > 1) {
                console.log(`Junction Resolver: Junction #${id} seems to have more than one output?!`);
                return;
            }

            let wires = node.wires[0];
            let resolved = [];

            // flag if we hit a circular reference from here
            let path_hit = false;

            for (let i=0, l=wires.length; i<l; i++) {

                let wire = wires[i];
                
                // console.log(wire, selfpath);

                if (selfpath.has(wire)) {
                    // console.log("xxx", wire);
                    path_hit = true;
                    continue;   // break the circle reference
                }

                let res = resolve_junction_wire(wire, selfpath);
                if (res) {
                    resolved.push(...res);
                }
            }

            if (!path_hit)
                node.wires[0] = resolved;

            return resolved;

        }

        // resolve junction nodes to wires
        nodes.forEach(function(node) {
            if (node.type !== "tab" && node.wires) {

                // console.log("???", node.wires);

                let resolved_wires = [];
                for (let output=0, l=node.wires.length; output<l; output++) {
                    let output_wires = new Set();
                    for (let w=0, lw=node.wires[output].length; w<lw; w++) {
                        
                        // console.log(node.id, "->", node.wires[output][w], "?");
                        
                        let rw = resolve_junction_wire(node.wires[output][w]);

                        // console.log(node.id, node.wires[output][w], rw);

                        if (rw) {
                            output_wires = new Set([...output_wires, ...rw]);
                        }
                    }
                    resolved_wires.push([...output_wires]);
                }

                node.wires = resolved_wires;

                // console.log("===>>", node.wires);
            }
        });

        // check if config nodes are referenced
        function test_for_config_node(obj) {
            for (const key in obj) {
                
                let ok = obj[key];

                if (ok && typeof(ok)==="object") {
                    test_for_config_node(ok);
                } else {
                    if (key!=="id" && key!=="z" && key!=="type" && typeof(ok)==="string" && ok.length == 16) {
                        if (configNodes[ok]) {
                            configNodes[ok]["mcu"] = true;
                        }
                    }        
                }
            }
        }

        for (let i=0;i<nodes.length; i++) {
            test_for_config_node(nodes[i]);
        }

        // add config nodes to the mcu nodes
        for (key in configNodes) {
            if (configNodes[key].mcu === true) {
                nodes.push(configNodes[key].node);
            }
        }

        // resolve core nodes directory => "@node-red/nodes"
        for (let i=0; i<manifest.resolver_paths.length; i+=1) {
            let pp = resolve_package_path("@node-red/nodes", manifest.resolver_paths[i]);
            if (pp) {
                manifest.add_build("REDNODES", path.dirname(pp));
            }
        }

        nodes.forEach(function(n) {

            // clean the config from the _mcu flag
            if (n._mcu) {
                delete n._mcu;
            }

            // verify that a manifest is available, create stubs for missing ones
            let node = library.get_node(n.type);
            if (!node) return;

            let module = node.module;
            if (!module) return;

            if (module === "node-red") {

                switch(n.type) {
                    case "trigger":
                        // let module = "@node-red/nodes/core/function/trigger";       // predefined template
                        // let mp = manifest.from_template(module, dest)
                        // if (mp && typeof(mp) === "string") {
                        //     manifest.include_manifest(mp);
                        // }
                        // return;
                        manifest.include_manifest("$(MCUROOT)/nodes/trigger/manifest.json")

                    default:
                        console.log(`Type "${n.type}" = core node: No manifest added.`);
                        return; 
                    
                }
            }

            if (manifest.resolver_paths.indexOf(node.path) < 0) {
                manifest.resolver_paths.push(node.path)
            }

            let p = manifest.get_manifest_of_module(module, dest);
            if (p && typeof(p) === "string") {
                manifest.include_manifest(p);
                return;
            }
            p = manifest.create_manifests_for_module(module, dest, n.type)
            if (p && typeof(p) === "string") {
                manifest.include_manifest(p);
                mainjs.push(`import "${module}"`);
            }

        });

        // In case this is going to be changed again ;)
        let flows_file_data = JSON.stringify(nodes, null, 2)
        let flows_file_name = "flows.json"

        // Write the flows file (currently flows.json)
        fs.writeFileSync(path.join(dest, flows_file_name), flows_file_data, (err) => {
            if (err) {
                throw err;
            }
        });

        // add our flows.json
        manifest.add_module({"source": "./flows", "transform": "nodered2mcu"})
        // manifest.add_preload("flows");

        // remove the standard (definition of) flows,json
        // let obsolete_flows_path = path.join(path.dirname(rmp), "flows.json");
        // obsolete_flows_path = obsolete_flows_path.slice(0, -path.extname(obsolete_flows_path).length)
        // "~" => exclude from build!
        // manifest.add_module(obsolete_flows_path, "~")
        // manifest.add_module({
        //     source: "$(MCUROOT)/flows",
        //     transform: "nodered2mcu"
        // }, "~");

        // Write the main.js file
        mainjs.push(...mainjs_end);
        fs.writeFileSync(path.join(dest, "main.js"), mainjs.join("\r\n"), (err) => {
            if (err) {
                throw err;
            }
        });

        manifest.add_module("./main")

        if (options?.creation) {
            let c = JSON.parse(options.creation)
            manifest.add(c, "creation");
        }

        // let test = {
        //     "static": 65536,
        //     "stack": 384,
        //     "keys": {
        //         "available": 64,
        //         "name": 53,
        //         "symbol": 3,
        //     },
        // }

        let m = manifest.get();
        // console.log(m);

        // Write the (root) manifest.json
        fs.writeFileSync(path.join(dest, "manifest.json"), manifest.get(), (err) => {
            if (err) {
                throw err;
            }
        });

        return dest;
    
    }

    async function build_flows(options, publish) {

        options = options ?? {};

        function _publish() {}
        publish = publish ?? _publish;

        function publish_stdout(msg) {
            publish("mcu/stdout/test", msg, false); 
        }

        function publish_stderr(msg) {
            publish("mcu/stdout/test", msg, false); 
        }

        publish_stdout("Starting Build process...")

        // create flows.json
        // create manifest.json for nodes in flows.json
        // create manifests for all dependencies
        // create an .env for the build command shell
        // - check that MODDABLE is valid
        // - check if IDF_PATH exists & is valid
        // create mcconfig command string
        // spawn shell
        // run IDF exports.sh
        // run mcconfig

        function ensure_env_path(name, path_options) {

            let n = process.env[name];
            if (n) {
                publish_stdout(`$${name} is defined: ${n}`)

                // verify that $name declares a valid path.
                if (!fs.existsSync(n)) {
                    throw(`$${name} is stating a non-existing path!`)
                }

                return n;
            }

            // Try to find path for $name
            for (let i = 0; i < path_options.length; i += 1) {
                if (fs.existsSync(path_options[i])) {
                    n = path_options[i];
                    break;
                }
            }
            
            if (!n) {
                throw(`$${name} is not defined.`)
            }

            publish_stdout(`$${name} identified: ${n}`);
            return n;
        }

        publish_stdout(`Creating build environment for platform ${options.platform}.`)

        // Define local dir as working_directory based on options.id
        const make_dir = path.join(RED.settings.userDir, "mcu-plugin-cache", `config${options.id}`);
        
        // only preliminary for testing!!
        fs.emptyDirSync(make_dir)

        make_build_environment(make_dir, options);

        publish_stdout(`Working directory: ${make_dir}`);

        let env = {
            "HOME": process.env.HOME,
            "SHELL": process.env.SHELL,
            "PATH": process.env.PATH,
            "MODDABLE": MODDABLE,
            "BUILD": path.resolve(MODDABLE, "build")
        }

        let platform = options.platform.split("/");
        
        const HOME = process.env.HOME ?? "";
        if (HOME.length < 1) {
            throw(`$HOME is not defined.`)
        }

        const pid = platform[0] ?? ""

        switch (pid) {
            case "esp":
                env.ESP_BASE = ensure_env_path("ESP_BASE", [
                    `${HOME}/esp`,
                    `${HOME}/.local/share/esp`
                ]);
                break;
            case "esp32":
                env.IDF_PATH = ensure_env_path("IDF_PATH", [
                    `${HOME}/esp32/esp-idf`,
                    `${HOME}/.local/share/esp32/esp-idf`
                ]);
                break;
            case "pico":

                switch (os.platform()) {
                    case "darwin":
                        switch (os.arch()) {
                            case "x64":
                                env.PICO_GCC_ROOT = ensure_env_path("PICO_GCC_ROOT", [ `/usr/local` ]);
                                break;
                            case "arm64":
                                env.PICO_GCC_ROOT = ensure_env_path("PICO_GCC_ROOT", [ `/opt/homebrew` ]);
                                break;
                        }
                        break;
                    case "linux":
                        env.PICO_GCC_ROOT = ensure_env_path("PICO_GCC_ROOT", [ `/usr` ]);
                        break;
                }

                env.PICO_SDK_DIR = ensure_env_path("PICO_SDK_DIR", [`${HOME}/pico/pico-sdk`]);

            case "gecko":
            case "qca4020":
                    // publish_stderr(`System setup support currently not implemented for platform ${options.platform}.`);
                    env.PLATFORM = pid;
                    if (platform[1]?.length > 0)
                        env.SUBPLATFORM = platform[1]
                    break;
            case "sim":
                break;
            default:
                throw(`Invalid platform identifier given: ${pid}`);
        }

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

        let shell_options = {
            "cwd": make_dir,
            "env": env
        };

        publish_stdout("> cd " + make_dir);

        const build_commands = {
            "sim": [
                cmd
            ],
            "esp": [
                cmd
            ],
            "esp32": [
                "source $IDF_PATH/export.sh",
                cmd
            ],
            "pico": [
                cmd
            ],
            "gecko": [
                cmd
            ],
            "qca4020": [
                cmd
            ]
        }

        let bcmds = [build_commands[pid].join(" && ")];

        switch (os.platform()) {
            case "linux":
                shell_options["SHELL"] = "/bin/bash"
                break;
        }

        const run_cmd = cmd => new Promise((resolve, reject) => {

            publish_stdout(`> ${cmd}`);

            let builder = exec(cmd, shell_options, (err, stdout, stderr) => {
                if (err) {
                    reject(err)
                }
                resolve();
            });

            builder.stdout.on('data', function(data) {
                publish_stdout(data); 
            });
            builder.stderr.on('data', function(data) {
                publish_stdout(data); 
            });

        });

        // https://stackoverflow.com/questions/40328932/javascript-es6-promise-for-loop
        return new Promise((resolve, reject) => {
            bcmds.reduce( (p, _, i) => 
                p.then(() => run_cmd(bcmds[i])),
                Promise.resolve() )
            .then(() => resolve())
            .catch((err) => reject(err));
        });

        // shell_options.shell = true;

        // const shell = getPersistentShell(process.env.SHELL, shell_options);

        // shell.process.stdout.on('data', function(data) {
        //     publish_stdout(data); 
        // });
        // shell.process.stderr.on('data', function(data) {
        //     publish_stderr(data); 
        // });

        // bcp = build_commands[pid];

        // for (let i=0; i<bcp.length; i++) {
        //     shell.execCmd(bcp[i]);
        // }
        // console.log("prebcmd")
        // // shell.process.stdin.emit('end');
        // shell.process.stdin.end();
        // console.log("post")
        // try {
        //     // let result = await shell.finalResult;
        //     let result = shell.finalResult;
        //     result.then((data) => {
        //         console.log("@then")
        //         console.log(data)
        //     })
        //     .catch((err) => {
        //         console.log("@catch")
        //         console.log(err)
        //     })
        // }
        // catch (err) {
        //     console.log("@tryatch")
        //     console.log(err);
        // }

        // console.log("end")

    } 


    function build_and_run(publish, options) {

        options = options ?? {};
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
                console.log(err);

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

                let mode = req.body.mode;
                if (mode === "reconnect") {
                    build_options.buildtarget = "xsbug";
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

                proxy.on("input", (data) => {
                    if (data.source && data.source.id) {

                        let id = data.source.id;
                        let node = RED.nodes.getNode(id);
                        if (node) {
                            delete data.source;
                            node.receive(data);
                        }
                    }
                })

                proxy.on("error", (data) => {
                    console.log(data);
                    if (data.source?.id) {

                        let id = data.source.id;
                        let node = RED.nodes.getNode(id);
                        if (node) {
                            console.log(data.error);
                            node.error(data.error);
                            // delete data.source;
                            // node.receive(data);
                        }
                    }
                })

                proxy.on("warn", (data) => {
                    console.log(data);
                    if (data.source?.id) {

                        let id = data.source.id;
                        let node = RED.nodes.getNode(id);
                        if (node) {
                            console.log(data.warn);
                            node.warn(data.warn);
                            // delete data.source;
                            // node.receive(data);
                        }
                    }
                })

                // build_and_run()
                // .then(msg => { console.log(msg) })
                // .catch(msg => {console.log("error @ build_and_run", msg)});

                // return build_and_run(RED.comms.publish, build_options)
                // .then((msg) => {
                //     // console.log("after build", msg)
                //     if (msg.error) {
                //         res.status(500).end();
                //     } else {
                //         res.status(200).end();
                //     }
                // })
                // .catch((err) => {
                //     // RED.comms.publish("mcu/stdout/test", "__flash_console", true)
                //     res.status(400).end();
                // })

                try {
                    build_flows(build_options, RED.comms.publish)
                    .then( () => {
                        res.status(200).end();
                    })
                    .catch((err) => {
                        console.log(err);
                        RED.comms.publish("mcu/stdout/test", err, false);
                        res.status(400).end();
                    })
                }
                catch (err) {
                    console.log(err);
                    RED.comms.publish("mcu/stdout/test", err, false);
                    res.status(400).end();
                }




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