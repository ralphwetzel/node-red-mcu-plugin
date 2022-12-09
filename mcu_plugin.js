const clone = require("clone");
// const { exec } = require('node:child_process'); // <== Node16 
const { exec, execFile, execSync } = require('child_process');  // Node14
const fs = require('fs-extra');
const os = require("os");
const path = require("path");
const {SerialPort} = require("serialport");

const app_name = "node-red-mcu-plugin";

const mcuProxy = require("./lib/proxy.js");
const mcuNodeLibrary = require("./lib/library.js");
const mcuManifest = require("./lib/manifest.js");

// ***** AbortController
// node@14: Established w/ 14.17; polyfill to be sure
// node@16+: Fully integrated
if (!globalThis.AbortController) {
    const { AbortController } = require("node-abort-controller");
    globalThis.AbortController = AbortController;
}

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
// Make available the Node-RED typeRegistry 

const typeRegistryPath = get_require_path("node_modules/@node-red/registry");
const typeRegistry = require(typeRegistryPath);

// *****
// Apply patch to get access to additional node related information
// This has to happen immediately when this file is required, before any Node-RED logic kicks in...

const registryUtilPath = get_require_path("node_modules/@node-red/registry/lib/util.js")
if (!registryUtilPath) return;

const registryUtil = require(registryUtilPath)

const orig_createNodeApi = registryUtil.createNodeApi;
function patched_createNodeApi(node) {

    if (node.file.indexOf("mcu_plugin.js") >= 0) {
    } else {
        if (node.types) {
            library.register_node(node);
        }
    }

    return orig_createNodeApi(node);
}
registryUtil.createNodeApi = patched_createNodeApi


// *** THIS DOESNT WORK!!
// We use this patch to get our hand on the full runtime.nodes API
let orig_copyObjectProperties = registryUtil.copyObjectProperties;
// console.log(orig_copyObjectProperties);

function patched_copyObjectProperties(src,dst,copyList,blockList) {

    if (!runtime_nodes && copyList.indexOf("createNode") >=0 && copyList.indexOf("getNode") >=0) {
        runtime_nodes = src;
        // console.log(runtime_nodes);
    }

    return orig_copyObjectProperties(src,dst,copyList,blockList);
}
// registryUtil.copyObjectProperties = patched_copyObjectProperties;

//
// *****

let __VERSIONS__ = {};

module.exports = function(RED) {

    // *****
    // Say hello ...
    try {

        let mcu_dir = path.resolve(__dirname, "./node-red-mcu");
        let git_describe = "git describe --abbrev=7 --always  --long";
        let mcu_version = execSync(git_describe, {"cwd": mcu_dir, input: "describe --abbrev=7 --always  --long", encoding: "utf-8"});
        if (typeof mcu_version == "string" && mcu_version.length > 0) {
            __VERSIONS__['runtime'] = mcu_version.trim();
            RED.log.info(`Node-RED MCU Edition Runtime Version: #${__VERSIONS__.runtime}`);
        }
        let my_package_json = require("./package.json");
        __VERSIONS__['plugin'] = my_package_json.version;
        RED.log.info(`Node-RED MCU Edition Plugin  Version: v${__VERSIONS__.plugin}`);

    } catch {}

    // End: Say hello...
    // *****


    // *****
    // env variable settings: Ensure ...
    
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

    // Try to get the version number of the MODDABLE SDK
    try {

        let git_describe = "git describe --abbrev=7 --always  --long";
        let moddable_version = execSync(git_describe, {"cwd": MODDABLE, input: "describe --abbrev=7 --always  --long", encoding: "utf-8"});
        if (typeof moddable_version == "string" && moddable_version.length > 0) {
            __VERSIONS__['moddable'] = moddable_version.trim();
            RED.log.info(`Moddable SDK Version: v${__VERSIONS__.moddable}`);
        }
    } catch {}

    // End: "env variable settings ..."
    // *****


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
    RED.nodes.registerType("_mcu:inject", mcu_inject);
    registerMCUModeType("inject", "_mcu:inject")

    function mcu_debug(config) {

        let dn;

        // Create a standard DebugNode
        let debugNodeConstructor = typeRegistry.get("debug");
        if (!debugNodeConstructor)
            return;

        dn = new debugNodeConstructor(config);

        // patch the "active" property for getter & setter !
        if ("active" in dn) {
            dn._active = dn.active;
            delete dn.active;
            Object.defineProperty(dn, "active", {
                get() {
                    return this._active;
                },
                set(status) {
                    this._active = status ? true : false;
                    if (this.__getProxy) {
                        let p = this.__getProxy();
                        if (p) {
                            p.send2mcu("debug", this.z, this.id, this._active);
                        }
                    }

                }
            })
        }
        return dn;
    }
    RED.nodes.registerType("_mcu:debug", mcu_debug);
    registerMCUModeType("debug", "_mcu:debug")

    // We use this node if no replacement is defined.
    // This gives us access to the basic functionality of a node, like emitting warnings & errors.
    function mcu_void(config) {

        // Let's give back this voided node it's original type!
        if ("void" in config) {
            config.type = config.void;
        }

        RED.nodes.createNode(this, config);
    }
    RED.nodes.registerType("_mcu:void", mcu_void);

    // End "Hook ..."
    // *****


    // *****
    // Calculate path to flowUtil (lib/flows/util.js) & require it

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

        let orig_type = config.type;

        if (config._mcu?.mcu === true) {
            if (config.type) {
                let t = library.get_mcumode_type(config.type)
                if (t) {
                    // replacing original node w/ _mcu:... node
                    config.type = t;

                } else {
                    // if no replacement node defined: Save the original type in config.void...
                    config.void = config.type;
                    // ... and create the void replacement node!
                    config.type = "_mcu:void";

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

    // Only for debugging
    let orig_diffConfigs = flowUtil.diffConfigs;
    function patched_diffConfigs(oldConfig, newConfig) {
        let res = orig_diffConfigs(oldConfig, newConfig);
        // console.log("diffConfigs", res);
        return res;
    }

    let orig_diffNodes = flowUtil.diffNodes;
    function patched_diffNodes(oldNode,newNode) {
        let res = orig_diffNodes(oldNode,newNode);
       // console.log("diffNodes", res);
        return res;
    }
    
    flowUtil.createNode = patched_createNode;
    flowUtil.diffNodes = patched_diffNodes;
    flowUtil.diffConfigs = patched_diffConfigs;

    // End "Apply..."
    // *****


    // ***** RDW221201: obsolete
    // function patch_xs_file(pre, post) {

    //     let moddable = process.env.MODDABLE
        
    //     if (moddable) {
    //         let os_file = {
    //             "darwin": "mac_xs.c"
    //         }
    
    //         let xs_file_path = path.join(moddable, 'xs', 'platforms', os_file[process.platform]);
    //         let xs_file = fs.readFileSync(xs_file_path).toString();
    //         let check_pre = "address.sin_port = htons(" + pre + ");";
    //         let check_post = "address.sin_port = htons(" + post + ");";
    //         if (xs_file.indexOf(check_pre) > 0) {
    //             xs_file = xs_file.replace(check_pre, check_post);
    //         }
    //         if (xs_file.indexOf(check_post) < 0) {
    //             throw "Failed to patch platform specific debug connection.";
    //         } else {
    //             console.log("Patch success confirmed @ " + post + ".");
    //             fs.writeFileSync(xs_file_path, xs_file);
    //         }
    //     } else {
    //         throw "Cannot proceed. $MODDABLE is not defined.";
    //     }
    //     return;
    // }
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
            RED.log.error(`${app_name}: Failed to open cache file @ ${cache_file}.`);
        } finally {
            cache_data = (cache_data.length > 0) ? cache_data : "[]"
        }

        try {
            cache_data = JSON.parse(cache_data) || {};
        } catch (err) {
            RED.log.warn(`${app_name}: Cache file corrupted @ ${cache_file}.`);
        }

        mcu_plugin_config.cache_file = cache_file;
        mcu_plugin_config.cache_data = cache_data;
    }

    function persist_cache(data) {
        if (!data) {
            data = mcu_plugin_config.cache_data;
        } else {
            mcu_plugin_config.cache_data = data;
        }

        let cache_data = JSON.stringify(data);
        fs.writeFile(mcu_plugin_config.cache_file, cache_data, err => {
            if (err) {
                RED.log.warn(`${app_name}: Failed to persist config to cache @ ${mcu_plugin_config.cache_file}.`);
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
            'esp32/esp32s3_usb',
            'esp32/heltec_lora_32',
            'esp32/heltec_wifi_kit_32',
            'esp32/kaluga',
            'esp32/lilygo_t5s',
            'esp32/lilygo_ttgo',
            'esp32/m5atom_echo',
            'esp32/m5atom_lite',
            'esp32/m5atom_matrix',
            'esp32/m5atom_u',
            'esp32/m5core_ink',
            'esp32/m5paper',
            'esp32/m5stack',
            'esp32/m5stack_core2',
            'esp32/m5stack_fire',
            'esp32/m5stick_c',
            'esp32/m5stick_cplus',
            'esp32/moddable_display_2',
            'esp32/moddable_two',
            'esp32/moddable_two_io',
            'esp32/moddable_zero',
            'esp32/nodemcu',
            'esp32/oddwires',
            'esp32/qtpys3',
            'esp32/s3_tft_feather',
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
                        RED.log.info(`*** ${app_name}:`);
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
                RED.log.info(`*** ${app_name}:`);
                RED.log.info("It looks as if a platform option has been removed.");
                RED.log.info("Please raise an issue @ our GitHub repository, stating the following information:");
                opener = false;
            }
            RED.log.info(`> Verify platform: ${platforms_verified[i]}`);
            platform_identifiers.splice(platform_identifiers.indexOf(platforms_verified[i]), 1);
        }

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
                        RED.log.info(`*** ${app_name}:`);
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
                RED.log.info(`*** ${app_name}:`);
                RED.log.info("It looks as if a simulator option has been removed.");
                RED.log.info("Please raise an issue @ our GitHub repository, stating the following information:");
                opener = false;
            }
            RED.log.info("> Verify simulator:", sims_verified[i]);
            delete simulator_identifiers[sims_verified[i]];
        }

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

    // The (single) promise when running a MCU target
    let runner_promise;
    // The AbortController for runner_promise
    let runner_abort;

    function make_build_environment(working_directory, options) {

        // Create target directory
        let dest = working_directory ?? fs.mkdtempSync(path.join(os.tmpdir(), app_name));
        fs.ensureDirSync(dest);


        let mainjs = [
            'import "nodered";	// import for global side effects',
        ];
        let mainjs_end = [
            'import flows from "flows";',
            'RED.build(flows);',
        ]

        let mainjs_ui_end = [
            'import flows from "flows";',
            'import buildModel from "./ui_nodes";',
            'import { REDApplication }  from "./ui_templates";',
            'RED.build(flows);',
            'const model = buildModel();',
            // 'export default new REDApplication(model, { commandListLength:8192, displayListLength:8192+4096, touchCount:1, pixels: 240 * 64 });'
        ]
        
        // Create and initialize the manifest builder
        let mcu_nodes_root = path.resolve(__dirname, "./mcu_modules");
        let manifest = new mcuManifest.builder(library, mcu_nodes_root);
        manifest.initialize();

        manifest.resolver_paths = [
            require.main.path,
            RED.settings.userDir
        ]

        // Try to make this the first entry - before the includes!

        // Add MODULES build path
        const mbp = path.resolve(MODDABLE, "./modules");
        manifest.add_build("MODULES", mbp);

        // Add root manifest from node-red-mcu
        // ToDo: node-red-mcu shall be a npm package as well - soon!
        const root_manifest_path = "./node-red-mcu"
        let rmp = path.resolve(__dirname, root_manifest_path);
        manifest.add_build("MCUROOT", rmp);
        manifest.include_manifest("$(MCUROOT)/manifest_runtime.json")

        // Add platform specific manifest - if there is one!
        let platform = options.platform.split("/");
        if (platform && platform[0].length > 0) {
            const platform_manifest_path = "./platforms";
            const pmp = path.resolve(__dirname, platform_manifest_path, platform[0], "manifest.json");
            if (fs.existsSync(pmp)) {
                manifest.include_manifest(pmp);
            }
        }

        // Make the flows.json file & add manifests of the nodes
        let nodes = [];
        let configNodes = {};

        // Very special node - providing base functionality for dashboard!
        // This node is not referenced by any other node;
        // thus we have to catch it when we stumble upon it!
        let ui_base;

        // identify the nodes flagged with _mcu & as well the config nodes
        RED.nodes.eachNode(function(nn) {

            // Catch ui_base
            if (nn.type == "ui_base") {
                ui_base = clone(nn);
                return;
            }

            // The "official" test for a config node!
            // This as well pushes "ui_group" & "ui_tab" nodes into configNodes
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
         * Resolve as well (standard) Link Out/In connections.
         * 
         * This could affect the total number of connection per output.
         * This code as well gets rid of circular references ... in case someone tries to play with the engine ;)
        */

        let resolver_cache = {};

        // initialize the resolver cache
        nodes.forEach(function (n) {
            resolver_cache[n.id] = n;
        })

        function resolve_wire(dest, path) {

            function getNode(id) {

                // first check the resolver cache
                let node = resolver_cache[id];

                if (!node) {

                    // try to get running instance of this id
                    let n = RED.nodes.getNode(id);

                    if (!n) {
                        // That's sh** !
                        console.log(`Wires Resolver: Couldn't get node definition for #${id}.`)
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

            let wires;

            switch (node.type) {
                case "link in":
                case "junction":

                    // shall exactly have one output!
                    if (!node.wires || !Array.isArray(node.wires) || node.wires.length < 1) {
                        return;     // doesn't hurt
                    }
                    if (node.wires.length > 1) {
                        console.log(`Wires Resolver: Node #${id} (${node.type}) seems to have more than one output?!`);
                        return;
                    }
                    wires = node.wires[0];
                    break;

                case "link out":
                    if (node.mode === "link") {
                        wires = node.links;
                        if (!wires || !Array.isArray(wires) || wires.length < 1)
                            return;
                        break;
                    }
                    // link.mode == "call" => treat as normal node!

                default:
                    return [dest];
            }

            // node IS (!) a junction or Link Out/In; continue resolving!

            if (wires.length == 0) {
                return;
            }

            let selfpath = path ? new Set([...path]) : new Set();
            selfpath.add(dest);

            let resolved = [];

            // flag if we hit a circular reference from here
            let path_hit = false;

            for (let i = 0, l = wires.length; i < l; i++) {

                let wire = wires[i];

                if (selfpath.has(wire)) {
                    path_hit = true;
                    continue;   // break the circle reference
                }

                let res = resolve_wire(wire, selfpath);
                if (res) {
                    resolved.push(...res);
                }
            }

            if (!path_hit)
                node.wires[0] = resolved;

            return resolved;

        }

        // resolve junction nodes & link nodes (out -> in) to wires
        nodes.forEach(function (node) {
            if (node.type !== "tab" && ("wires" in node)) {

                let resolved_wires = [];
                for (let output = 0, l = node.wires.length; output < l; output++) {
                    let output_wires = new Set();
                    for (let w = 0, lw = node.wires[output].length; w < lw; w++) {

                        let rw = resolve_wire(node.wires[output][w]);
                        if (rw) {
                            output_wires = new Set([...output_wires, ...rw]);
                        }
                    }
                    resolved_wires.push([...output_wires]);
                }

                node.wires = resolved_wires;

            }
        });

        // Remove Link Out/In nodes
        nodes = nodes.filter(function(node) {
            switch (node.type) {
                case "link out":
                    return (node.mode !== "link");

                case "link in":

                    // check if this "link in" node is target of a "link call" node!
                    for (let i=0, l=nodes.length; i<l; i++) {
                        let n = nodes[i];
                        if (n.type === "link call") {
                            if (n.links && Array.isArray(n.links) && n.links.length>0) {
                                if (n.links[0] === node.id){
                                    return true;
                                }
                            }
                        }
                    }

                    // If not: eliminate!
                    return false;

                default:
                    return true;
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
                        cn = configNodes[ok];
                        if (cn && (cn.mcu !== true)) {
                            cn.mcu = true;
                            // recursion necessary e.g. for ui_nodes
                            test_for_config_node(cn);
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

        let ui_support_demand_confirmed = false;

        // *****
        // Map Node-RED node definitions to node-red-mcu core manifest.json files

        // Check directories in node-red-mcu/nodes
        // Latest check: 20220912/RDW

        // core: Node of node-red; type -> nr_type_map
        // mcu: Contrib node; module id -> mcu_module_map
        // package: Has dedicated package.json; no action

        // audioout => package
        // batch => core
        // csv => core
        // delay => core
        // file => core (file, file in)
        // httprequest => core (http request)
        // httpserver => core (hhtp in, http response)
        // join => core
        // lower-case => package
        // openweathermap => mcu
        // random => core
        // rpi-ds18b20 => mcu
        // rpi-gpio => mcu
        // rpi-neopixels => mcu
        // sensor => package
        // sort => core
        // template => core
        // trigger => core
        // udp => core (udp in, udp out)
        // ui => DEDICATED HANDLING
        // websocketnodes => core (websocket-client, websocket-listener, websocket in, websocket out)

        function mcu_manifest(name) {
            return `$(MCUROOT)/nodes/${name}/manifest.json`
        }

        // need to map here every type covered
        const nr_type_map = {
            "batch": "batch",
            "csv": "csv",
            "delay": "delay",
            "file": "file",
            "file in": "file",
            "http request": "httprequest",
            "http in": "httpserver",
            "http response": "httpserver",
            "join": "join",
            "random": "random",
            "sort": "sort",
            "template": "template",
            "trigger": "trigger",
            "udp in": "udp",
            "udp out": "udp",
            "websocket-client": "websocketnodes",
            "websocket-listener": "websocketnodes",
            "websocket in": "websocketnodes",
            "websocket out": "websocketnodes",
        }

        // always map the (full) module
        const mcu_module_map = {

            "node-red-node-openweathermap": mcu_manifest("openweathermap"),

            // https://github.com/bpmurray/node-red-contrib-ds18b20-sensor
            "node-red-contrib-ds18b20-sensor": mcu_manifest("rpi-ds18b20"),
            
            "node-red-node-pi-gpio": mcu_manifest("rpi-gpio"),
            "node-red-node-pi-neopixel": mcu_manifest("rpi-neopixels"),    // Att: this is pixel vs. pixel"s"
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
                if (n.type in nr_type_map) {
                    manifest.include_manifest(mcu_manifest(nr_type_map[n.type]));
                }
                else {
                    // Not adding any additional manifest for Node-RED core nodes.
                }
                return;

            } else if (module in mcu_module_map) {
                // mcu_module_map already defines path to manifest.json
                manifest.include_manifest(mcu_module_map[module]);
                return;

            } else if (module === "node-red-dashboard") {
                if (!options.ui) {
                    throw Error("This flow uses UI nodes - yet UI support is diabled. Please enable UI support.")
                }

                ui_support_demand_confirmed = true;
                return;

            } else if (module.indexOf("node-red-node-ui-") === 0) {
                throw Error(`Node type '${module}' currently not supported on MCU.`)
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

        // Check if there is any node to be build
        if (nodes.length < 1) {
            throw Error("No flow to build.")
        }

        // UI_Nodes support
        if (ui_support_demand_confirmed && options.ui) {

            // add ui_base node to the group of nodes to be exported!
            if (!ui_base) {

                // There might be situations where ui_base was deleted in the editor;
                // rather than throwing here, we try to create a minimal / standard replacement node

                ui_base = {
                    id: RED.nodes.id(),
                    type: "ui_base",
                    theme: {
                        name: "theme-dark",
                        lightTheme: {
                            default: "#0094CE",
                            baseColor: "#0094CE",
                            baseFont: "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Oxygen-Sans,Ubuntu,Cantarell,Helvetica Neue,sans-serif",
                            edited: true,
                            reset: false
                        },
                        darkTheme: {
                            default: "#097479",
                            baseColor: "#097479",
                            baseFont: "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Oxygen-Sans,Ubuntu,Cantarell,Helvetica Neue,sans-serif",
                            edited: true,
                            reset: false
                        },
                        themeState: {
                            "base-color": {
                                default: "#097479",
                                value: "#097479",
                                edited: false
                            },
                            "page-titlebar-backgroundColor": {
                                value: "#097479",
                                edited: false
                            },
                            "page-backgroundColor": {
                                value: "#111111",
                                edited: false
                            },
                            "page-sidebar-backgroundColor": {
                                value: "#333333",
                                edited: false
                            },
                            "group-textColor": {
                                value: "#0eb8c0",
                                edited: false
                            },
                            "group-borderColor": {
                                value: "#555555",
                                edited: false
                            },
                            "group-backgroundColor": {
                                value: "#333333",
                                edited: false
                            },
                            "widget-textColor": {
                                value: "#eeeeee",
                                edited: false
                            },
                            "widget-backgroundColor": {
                                value: "#097479",
                                edited: false
                            },
                            "widget-borderColor": {
                                value: "#333333",
                                edited: false
                            },
                            "base-font": {
                                value: "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Oxygen-Sans,Ubuntu,Cantarell,Helvetica Neue,sans-serif"
                            }
                        },
                        angularTheme: {
                            primary: "indigo",
                            accents: "blue",
                            warn: "red",
                            background: "grey",
                            palette: "dark"
                        }
                    },
                    site: {
                        name: "Node-RED Dashboard",
                        hideToolbar: "false",
                        allowSwipe: "false",
                        lockMenu: "false",
                        allowTempTheme: "none",
                        dateFormat: "DD.MM.YYYY",
                        sizes: {
                            sx: 48,
                            sy: 48,
                            gx: 6,
                            gy: 6,
                            cx: 6,
                            cy: 6,
                            px: 0,
                            py: 0
                        }
                    }
                }

            }

            nodes.push(ui_base);

            // Dedicated includes
            manifest.include_manifest("$(MCUROOT)/nodes/ui/manifest.json");

            // @ToDo: Check if really necessary!
            manifest.include_manifest("$(MCUROOT)/nodes/random/manifest.json");
            manifest.include_manifest("$(MCUROOT)/nodes/trigger/manifest.json");

            // Dedicated main.js
            mainjs.push(...mainjs_ui_end);
            
            let app_options = {
                commandListLength: options.cll,
                displayListLength: options.dll,
                touchCount: options.tc,
                pixels: options.px * options.py
            }

            mainjs.push(`export default new REDApplication(model, ${JSON.stringify(app_options)});`);
        } else {
            mainjs.push(...mainjs_end);
        }

        // Write the main.js file
        fs.writeFileSync(path.join(dest, "main.js"), mainjs.join("\r\n"), (err) => {
            if (err) {
                throw err;
            }
        });

        manifest.add_module("./main")

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

        if (options?.creation) {
            let c = JSON.parse(options.creation)
            manifest.add(c, "creation");
        }

        // enable editor message transmossion by the MCU
        let editor_transmission_on = { "noderedmcu": { "editor": true }};
        manifest.add(editor_transmission_on, "config");

        let m = manifest.get();

        // Write the (root) manifest.json
        fs.writeFileSync(path.join(dest, "manifest.json"), manifest.get(), (err) => {
            if (err) {
                throw err;
            }
        });

        return dest;
    
    }

    function build_flows(options, publish) {

        options = options ?? {};

        function _publish() {}
        publish = publish ?? _publish;

        function publish_stdout(msg) {
            publish("mcu/stdout/test", msg, false); 
        }

        function publish_stderr(msg) {
            publish("mcu/stdout/test", msg, false); 
        }

        publish_stdout("Starting build process...")

        publish_stdout(`Host system check: ${os.version()}`);
        publish_stdout(`MCU Build system check: p${__VERSIONS__.plugin} + #${__VERSIONS__.runtime} @ m${__VERSIONS__.moddable}` );
        publish_stdout(`HOME directory check: ${os.homedir()}`);

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

        /**
         *
         * @param {string} name - name of the environment variable
         * @param {(string | object)[]} path_options - alternative paths to be checked
         * @param {string} path_options[].test - file / directory path to check for existance 
         * @param {string} path_options[].value - value to be assigned to environment variable if test is successful 
         * @returns {string} path that is verified to exist
         *
         */

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
                let po = path_options[i];
                let test;
                let value;
                if (typeof po === "object") {
                    test = po.test ?? po.value ?? undefined;
                    value = po.value ?? test ?? undefined;
                } else {
                    test = value = po;
                }
                if (test && value && fs.existsSync(test)) {
                    n = value;
                    break;
                }
            }
            
            if (!n) {
                throw(`$${name} is not defined.`)
            }

            // path_options can declare as well a file to be checked for existance
            // to be more precise in defining what we expect as "fingerprint" of the env variable setting 
            let stat;
            try {
                stat = fs.statSync(n);
            } catch {}

            if (stat?.isFile()) {
                n = path.dirname(n);
            }

            publish_stdout(`$${name} identified: ${n}`);
            return n;
        }

        publish_stdout(`Creating build environment for platform ${options.platform}.`)

        // Define local dir as working_directory based on options.id
        const make_dir = path.join(RED.settings.userDir, "mcu-plugin-cache", `${options.id}`);
        
        // only preliminary for testing!!
        fs.emptyDirSync(make_dir)

        try {
            make_build_environment(make_dir, options);
        } catch (err) {
            publish_stderr(err.toString());
            return Promise.reject(err);
        }

        publish_stdout(`Working directory: ${make_dir}`);

        let env = {
            "HOME": os.homedir(),
            "SHELL": process.env.SHELL,
            "PATH": process.env.PATH,
            "MODDABLE": MODDABLE,
            "BUILD": path.resolve(MODDABLE, "build")
        }

        let platform = options.platform.split("/");
        
        env.PLATFORM = platform[0];
        if (platform[1]?.length > 0)
            env.SUBPLATFORM = platform[1]

        const HOME = env.HOME ?? "";
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
                                env.PICO_GCC_ROOT = ensure_env_path("PICO_GCC_ROOT", [ {test: "/usr/local/bin/arm-none-eabi-gcc", value: `/usr/local`} ]);
                                break;
                            case "arm64":
                                env.PICO_GCC_ROOT = ensure_env_path("PICO_GCC_ROOT", [ {test: "/opt/homebrew/bin/arm-none-eabi-gcc", value: `/opt/homebrew`} ]);
                                break;
                        }
                        break;
                    case "linux":
                        env.PICO_GCC_ROOT = ensure_env_path("PICO_GCC_ROOT", [ {test: "/usr/bin/arm-none-eabi-gcc", value: "/usr"} ]);
                        break;
                }

                env.PICO_SDK_DIR = ensure_env_path("PICO_SDK_DIR", [`${HOME}/pico/pico-sdk`]);
                break;

            case "gecko":
            case "qca4020":
                    // publish_stderr(`System setup support currently not implemented for platform ${options.platform}.`);
                    // env.PLATFORM = pid;
                    // if (platform[1]?.length > 0)
                    //     env.SUBPLATFORM = platform[1]
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

        {
            let args = {};
            if (options.arguments) {
                args = JSON.parse(options.arguments);
            }
            if (options.ssid) {
                args['ssid'] = options.ssid;
            }
            if (options.password) {
                args['password'] = options.password;
            }

            for (key in args) {
                cmd += " " + key + '="' + args[key] + '"'
            }
        }

        let runner_options = {
            "cwd": make_dir,
            "env": env
        };

        publish_stdout("> cd " + make_dir);

        let bcmds = [cmd];  // build_commands

        switch (pid) {
            case "sim":
            case "esp":
                // bcmds = [cmd];
                break;
            case "esp32":
                if (os.platform() === "win32") {
                    // execFile doesn't expand the env variables... ??
                    bcmds = [
                        `CALL "${process.env["ProgramFiles"]}\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat"`,
                        'pushd %IDF_PATH%',
                        `CALL "${process.env["IDF_TOOLS_PATH"]}\\idf_cmd_init.bat"`,
                        'popd',
                        cmd
                    ]
                } else {
                    bcmds = [
                        '#!/bin/bash',
                        'runthis(){',
                        '   echo ">> $@"',
                        '   eval "$@"',
                        '}',
                        'runthis "source "$IDF_PATH/export.sh""',
                        `runthis "${cmd}"`
                    ]
                }
                break;
            case "pico":
            case "gecko":
            case "qca4020":
                // bcmds = [cmd];
                break;
        }

        let run_cmd;

        runner_abort = new AbortController();
        runner_options["signal"] = runner_abort.signal;

        switch (os.platform()) {
            case "win32":

                // idf_tool.py generates PYTHON_PLATFORM as "platform.system() + '-' + platform.machine()".
                // platform.machine() operates w/ $PROCESSOR_ARCHITECTURE as fallback value.
                // Reference: https://github.com/python/cpython/blob/d92407ed497e3fc5acacb0294ab6095013e600f4/Lib/platform.py#L763-L788
                // If $PROCESSOR_ARCHITECTURE is not defined, platform.machine() will / could return "" & ...
                // the build process (potentially) terminate with "ERROR: Platform Windows- appears to be unsupported".
                // Thus offer $PROCESSOR_ARCHITECTURE in the build env:
                env["PROCESSOR_ARCHITECTURE"] = process.env["PROCESSOR_ARCHITECTURE"];

                runner_options["windowsHide"] = true;

                publish_stdout("Creating build batch file...")
                fs.writeFileSync(path.join(make_dir, "build.bat"), bcmds.join("\r\n"))
                bcmds = ["build.bat"];

                run_cmd = filename => new Promise((resolve, reject) => {

                    publish_stdout(`> cmd.exe ${filename}`);

                    let builder = execFile(filename, undefined, runner_options, (err, stdout, stderr) => {
                        if (err) {
                            if (err.code == "ABORT_ERR") {
                                resolve();
                                return;
                            }
                            reject(err);
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
                break;
            
            case "linux":
                // runner_options["shell"] = "/bin/bash";

            case "darwin":

                publish_stdout("Creating build script file...")
                fs.writeFileSync(path.join(make_dir, "build.sh"), bcmds.join("\n"))
                bcmds = ["./build.sh"];

                run_cmd = filename => new Promise((resolve, reject) => {

                    publish_stdout(`> /bin/bash ${filename}`);

                    let builder = execFile("/bin/bash", [filename], runner_options, (err, stdout, stderr) => {
                        if (err) {
                            if (err.code == "ABORT_ERR") {
                                resolve();
                                return;
                            }
                            reject(err);
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
                break;
    
    
            default:

                bcmds = [bcmds.join(" && ")];

                run_cmd = cmd => new Promise((resolve, reject) => {

                    publish_stdout(`> ${cmd}`);
        
                    let builder = exec(cmd, runner_options, (err, stdout, stderr) => {
                        if (err) {
                            if (err.code == "ABORT_ERR") {
                                resolve();
                                return;
                            }
                            reject(err);
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
        
        }

        // this can be simplified - as we're meanwhile only running 1-liners

        // https://stackoverflow.com/questions/40328932/javascript-es6-promise-for-loop
        // return new Promise((resolve, reject) => {
        //     bcmds.reduce( (p, _, i) => 
        //         p.then(() => run_cmd(bcmds[i])),
        //         Promise.resolve() )
        //     .then(() => resolve())
        //     .catch((err) => reject(err));
        // });


        return new Promise((resolve, reject) => {
            Promise.resolve()
            .then(() => run_cmd(bcmds[0]))
            .then(() => resolve())
            .catch((err) => reject(err));
        });

    } 
    

    RED.plugins.registerPlugin("node-red-mcu", {
        onadd: () => {

            RED.httpAdmin.post(`${apiRoot}/flows2build`, routeAuthHandler, (req, res) => {
                if (req.body && req.body.flows2build) {
                    flows2build = req.body.flows2build;
                }
                res.status(200).send('OK');
            });

            RED.httpAdmin.post(`${apiRoot}/build`, routeAuthHandler, (req, res) => {
                
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


                // abort the currently running runner
                if (runner_promise && runner_abort) {
                    // console.log("Aborting...")
                    runner_abort.abort();
                    delete runner_promise;
                    delete runner_abort;
                }

                // create the proxy to the MCU / Simulator
                if (proxy) {
                    proxy.disconnect();
                    delete proxy;
                }

                proxy = new mcuProxy.proxy();

                proxy.on("status", (id, data) => {

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
        
                    if (id) {
                        RED.events.emit("node-status",{
                            "id": id,
                            "status": status
                        });    
                    }
        
                })

                proxy.on("input", (id, data) => {
                    if (id) {
                        let node = RED.nodes.getNode(id);
                        if (node) {
                            node.receive(data);
                        }
                    }
                })

                proxy.on("error", (id, data) => {
                    if (id) {
                        let node = RED.nodes.getNode(id);
                        if (node) {
                            node.error(data.error);
                        }
                    }
                })

                proxy.on("warn", (id, data) => {
                    if (id) {
                        let node = RED.nodes.getNode(id);
                        if (node) {
                            node.warn(data.warn);
                        }
                    }
                })

                proxy.on("mcu", (data) => {

                    let token = "state";

                    if (token in data === false)
                        return;
                    
                    let s = data[token];
                    let msg;
                    let options;

                    switch (s) {
                        case "login":

                            let from = data.from
                            if (from.length > 0) {
                                if (from === "main") {
                                    msg = "MCU is initializing...";
                                } else if (from.length > 6) {
                                    let c = from.substring(0, 6);
                                    let c_id = from.substring(6);
                                    if (c === "config" && c_id == build_options.id) {
                                        msg = "Simulator is initializing...";
                                    }
                                }
                            }

                            options = { type: "warning", timeout: 5000 };
                            break;
                        
                        case "building":

                        // building & ready fire almost simultaneously

                        //     msg = "MCU building flows...";
                        //     options = { type: "warning", timeout: 1000 };
                        //     break;

                        // case "ready":
                            msg = "Flows are ready.";
                            options = { timeout: 5000 };
                            break;

                        default:
                            return;

                    }

                    if (msg && msg.length > 0) {
                        RED.comms.publish("mcu/notify",  {
                            "message": msg, 
                            "options": options
                        });    
                    }

                })

                try {
                    runner_promise = build_flows(build_options, RED.comms.publish)
                    .then( () => {
                        res.status(200).end();
                    })
                    .catch((err) => {
                        // RED.comms.publish("mcu/stdout/test", err.toString(), false);
                        res.status(400).end();
                    })
                }
                catch (err) {
                    RED.comms.publish("mcu/stdout/test", err.toString(), false);
                    res.status(400).end();
                }

            });


            RED.httpAdmin.get(`${apiRoot}/config`, routeAuthHandler, (req, res) => {
                let c = {
                    "config": mcu_plugin_config.cache_data
                }
                res.status(200).end(JSON.stringify(c), "utf8")
            })

            RED.httpAdmin.get(`${apiRoot}/config/plugin`, routeAuthHandler, (req, res) => {
                let c = {
                    "platforms": mcu_plugin_config.platforms,
                    "ports": mcu_plugin_config.ports
                }
                res.status(200).end(JSON.stringify(c), "utf8")
            })

            RED.httpAdmin.post(`${apiRoot}/config`, routeAuthHandler, (req, res) => {
                let config;
                if (req.body && req.body.config) {
                    config = req.body.config;
                } else {
                    RED.log.error(`${app_name}: Failed to parse incoming config data.`);
                    res.status(400).end();
                    return;
                }
                persist_cache(config);
                res.status(200).end();    
            })
                      
        }
    });
    
}
