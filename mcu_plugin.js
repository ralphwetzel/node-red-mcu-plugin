/*
    node-red-mcu-plugin by @ralphwetzel
    https://github.com/ralphwetzel/node-red-mcu-plugin
    License: MIT
*/

const clone = require("clone");
// const { exec } = require('node:child_process'); // <== Node16 
const { exec, execFile, execSync } = require('child_process');  // Node14
const fs = require('fs-extra');
const os = require("os");
const path = require("path");
const {SerialPort} = require("serialport");

const Eta = require("eta");

const app_name = "node-red-mcu-plugin";

const mcuProxy = require("./lib/proxy.js");
const mcuNodeLibrary = require("./lib/library.js");
const mcuManifest = require("./lib/manifest.js");

const mcuMessageRelay = require("./lib/relay.js")

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
let proxy_port_mcu = 5004;

let proxy_port_xsbug = 5002;
let proxy_port_xsbug_log = 50002;

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

    /* This are some known patterns:
        require.main.path:
            dev:        [...]/node-red/packages/node_modules/node-red
            install:    [...]/lib/node_modules/node-red
            pi:         /lib/node_modules/node-red/
            docker:     /usr/src/node-red/node_modules/node-red

        target:
            dev:        [...]/node-red/packages/node_modules/@node-red
            install:    [...]/lib/node_modules/node-red/node_modules/@node-red
            pi:         /lib/node_modules/node-red/node_modules/@node-red
            docker:     /usr/src/node-red/node_modules/@node-red
    */

    if (rms.includes("packages"))  {
        if (rms[rmsl-3]=="packages" && rms[rmsl-2]=="node_modules" && rms[rmsl-1]=="node-red") {
            rms.splice(-2);
        }
    } else if (rms[0]=="usr" && rms[1]=="src" && rms[2]=="node-red" && rmsl==5) {
        rms.splice(-2);
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
if (!typeRegistryPath) return;
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

// *****
// *
// * Currently used EXPERIMENTAL Flags:
// *
// * 1: Mod Build Support
// * 2: -- (next free)
// * 4: ...
//
// * => This is tested as bit field!
// *****
let MCU_EXPERIMENTAL = process.env['MCU_EXPERIMENTAL'];

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
    // path.normalize ensures correct slash type (see issue #11)
    const MODDABLE = process.env.MODDABLE ? path.normalize(process.env.MODDABLE) : undefined;
    
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

    // Check version of MODDABLE tools on Windows

    if (os.platform() === "win32") {
        let testcmd = [
            `CALL "${process.env["ProgramFiles"]}\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat" > nul`,
            `cd /D ${MODDABLE}\\build\\bin\\win\\debug`,
            'dumpbin /headers xsbug.exe | findstr "machine"'
        ].join(" && ");

        try {
            // This doesn't test for i64 (!!)
            let test = execSync(testcmd, {"encoding": "utf-8"});
            __VERSIONS__['x_win'] = (test.indexOf("(x64)") > 0) ? "64" : "32"
        } catch {}
    }

    // Try to get the version number of the MODDABLE SDK
    // This check is used to verify that the SDK is truly present in $MODDABLE!
    try {

        let git_describe = "git describe --abbrev=7 --always  --long";
        let moddable_version = execSync(git_describe, {"cwd": MODDABLE, input: "describe --abbrev=7 --always  --long", encoding: "utf-8"});
        if (typeof moddable_version == "string" && moddable_version.length > 0) {
            __VERSIONS__['moddable'] = moddable_version.trim();
            
            if (__VERSIONS__.x_win) {
                RED.log.info(`Moddable SDK Version: v${__VERSIONS__.moddable} (${"32" === __VERSIONS__.x_win ? "x86" : "x64"})`);
            } else {
                RED.log.info(`Moddable SDK Version: v${__VERSIONS__.moddable}`);
            }
        }
    } catch (err) {
        RED.log.error("*** node-red-mcu-plugin -> Error!");
        RED.log.error(`* Failed to query for Moddable SDK Version: "${err.stderr.trim()}"`);
        RED.log.error("* There seems to be an issue with this installation, that we cannot mitigate!");
        RED.log.error("*** node-red-mcu-plugin -> Runtime setup canceled.");
        return;
    }

    // get the commit hash of the main.js
    try {
        MAINJS = "99917a1";
        let git_log = "git log -n 1 --pretty=format:%h -- main.js";
        let mainjs_version = execSync(git_log, {"cwd": path.join(__dirname, "node-red-mcu"), encoding: "utf-8"});
        if (mainjs_version !== MAINJS) {
            RED.log.info(`*** ${app_name}: main.js version update indicated: #${MAINJS} -> #${mainjs_version}`);
        }
    } catch(err) {}

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

        // This affects the runtime representation of the node!
        if (!this._mcu) {
            this._mcu = {};
        }
        this._mcu.reset_status_on_abort = true;

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

        // This affects the runtime representation of the node!
        if (!dn._mcu) {
            dn._mcu = {};
        }
        dn._mcu.reset_status_on_abort = true;

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

        // This affects the runtime representation of the node!
        if (!this._mcu) {
            this._mcu = {};
        }
        this._mcu.reset_status_on_abort = true;
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


    // ****
    // Instance to forward messages from the MCU into runtime
    let mcuRelay = new mcuMessageRelay.relay(RED);


    // *****
    // Apply a patch to hook into the node creation process of the runtime.

    function getProxy() {
        if (proxy) return proxy;
    }

    let orig_createNode = flowUtil.createNode;
    async function patched_createNode(flow,config) {

        let orig_type = config.type;
        let give_proxy = false;

        if (config._mcu?.mcu === true) {
            if (config.type) {
                let t = library.get_mcumode_type(config.type)
                if (t) {
                    // replacing original node w/ _mcu:... node
                    config.type = t;
                    give_proxy = true;

                } else {
                    // if no replacement node defined: Save the original type in config.void...
                    config.void = config.type;
                    // ... and create the void replacement node!
                    config.type = "_mcu:void";

                }
            }
        }

        let node = await orig_createNode(flow, config);

        // give mcu replacement nodes access to the proxy
        if (give_proxy) {
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
            'esp32/c3_devkit_rust',
            'esp32/esp32_st7789',
            'esp32/esp32_thing',
            'esp32/esp32_thing_plus',
            'esp32/esp32c3',
            'esp32/esp32c3_cdc',
            'esp32/esp32c6',
            'esp32/esp32c6_cdc',
            'esp32/esp32c6_gc9a01',
            'esp32/esp32h2',
            'esp32/esp32h2_cdc',
            'esp32/esp32h2_ili9341',
            'esp32/esp32s3',
            'esp32/esp32s3_cdc',
            'esp32/esp32s3_usb',
            'esp32/feather_s3_tft',
            'esp32/heltec_lora_32',
            'esp32/heltec_wifi_kit_32',
            'esp32/kaluga',
            'esp32/lilygo_t5s',
            'esp32/lilygo_t_qt',
            'esp32/lilygo_t_camera_plus_s3',
            'esp32/lilygo_tdisplay_s3',
            'esp32/lilygo_ttgo',
            'esp32/lolin_c3mini',
            'esp32/lolin_c3pico',
            'esp32/lolin_s2mini',
            'esp32/m5atom_echo',
            'esp32/m5atom_lite',
            'esp32/m5atom_matrix',
            'esp32/m5atom_s3',
            'esp32/m5atom_s3_lite',
            'esp32/m5atom_s3r',
            'esp32/m5atom_s3_org',
            'esp32/m5atom_u',
            'esp32/m5core_ink',
            'esp32/m5dial',
            'esp32/m5nanoc6',
            'esp32/m5paper',
            'esp32/m5stack',
            'esp32/m5stack_core2',
            'esp32/m5stack_cores3',
            'esp32/m5stack_fire',
            'esp32/m5stamp_s3',
            'esp32/m5stick_c',
            'esp32/m5stick_cplus',
            'esp32/moddable_display_2',
            'esp32/moddable_display_6',
            'esp32/moddable_six',
            'esp32/moddable_six_cdc',
            'esp32/moddable_two',
            'esp32/moddable_two_io',
            'esp32/moddable_two_io_v5',
            'esp32/moddable_zero',
            'esp32/nodemcu',
            'esp32/oddwires',
            'esp32/qtpyc3',
            'esp32/qtpyc3_ili9341',
            'esp32/qtpys2',
            'esp32/qtpys2_ili9341',
            'esp32/qtpys3',
            'esp32/qtpys3_cdc',
            'esp32/qtpys3_ili9341',
            'esp32/saola_wroom',
            'esp32/saola_wrover',
            'esp32/wemos_oled_lolin32',
            'esp32/wrover_kit',
            'esp32/wt32_eth01',
            'esp32/xiao_esp32c3',
            'esp32/xiao_esp32c3_ili9341',
            'esp32/xiao_esp32s3',
            'esp32/xiao_esp32s3_ili9341',
            'esp32/xiao_esp32s3_sense',
            'gecko/blue',
            'gecko/giant',
            'gecko/mighty',
            'gecko/thunderboard',
            'gecko/thunderboard2',
            'nrf52/dk',
            'nrf52/itsybitsy',
            'nrf52/makerdiary_nrf52',
            'nrf52/moddable_display_4',
            'nrf52/moddable_four',
            'nrf52/moddable_four_io',
            'nrf52/moddable_four_uart',
            'nrf52/sparkfun',
            'nrf52/xiao',
            'nrf52/xiao_ili9341',
            'pico/captouch',
            'pico/ili9341',
            'pico/ili9341_i2s',
            'pico/itsybitsy',
            'pico/lilygo_t_display',
            'pico/pico_2',
            'pico/pico_display',
            'pico/pico_display_2',
            'pico/pico_lcd_1.3',
            'pico/pico_plus_2',
            'pico/pico_w',
            'pico/picosystem',
            'pico/pro_micro',
            'pico/qt_trinkey',
            'pico/qtpy',
            'pico/qtpy_ili9341',
            'pico/sparkfun_rp2350',
            'pico/tiny2040',
            'pico/ws_round',
            'pico/ws_round_touch',
            'pico/xiao_ili9341',
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

        // add generic build targets
        mcu_plugin_config.platforms = [];

        ["esp", "esp32"].forEach((p) => {
            mcu_plugin_config.platforms.push({value: p})
        })

        mcu_plugin_config.platforms.push(...platforms);

    }

    {
        // Those are the available sims we are aware of:
        let simulator_identifiers = {
            'sim/m5paper': "M5Paper",
            'sim/m5stack' : "M5Stack",
            'sim/m5stickc': "M5Stick",
            'sim/moddable_one': "Moddable One",
            'sim/moddable_two': "Moddable Two",
            'sim/moddable_three': "Moddable Three",     // this order looks better
            'sim/moddable_four': "Moddable Four",
            'sim/moddable_six': "Moddable Six",
            'sim/nodemcu': "Node MCU",
            'sim/pico_display': "Pico Display",
            'sim/pico_display_2': "Pico Display2",
            'sim/pico_ws_round': "Pico Round Display / WaveShare"
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
                    RED.log.info(`> New simulator: ${id}`);
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

                // Only process true hardware devices, reporting vendorId & productId.
                // This might become an issue at some point in time ... to be addressed then!
                if (!p[i].vendorId && !p[i].productId) {
                    continue;
                }

                if (p[i].path && p[i].path.length > 0) {

                    let pth = p[i].path;
                    if ("darwin" === os.platform()) {
                        // SerialPort (usually / only) reports the "/dev/tty." devices.
                        // On MacOs, we yet need the  "/dev/cu."s to launch successfully!
                        if (-1 < pth.indexOf("/dev/tty.")) {
                            pth = pth.replace("/dev/tty.", "/dev/cu.")
                        } else {
                            continue;
                        }
                    }
                    ports.push(pth);
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

    RED.events.on("flows:stopping", (...args) => {

        let flows = args[0]?.config?.flows;

        if (flows && Array.isArray(flows)) {
            for (let i=0; i<flows.length; i++) {
                let f = flows[i];
                if (f?._mcu?.mcu) {
                    // abort the currently running runner
                    if (runner_promise && runner_abort) {
                        runner_abort.abort();
                        delete runner_promise;
                        delete runner_abort;
                        if (proxy) {
                            proxy.disconnect();
                            delete proxy;
                        }
                        RED.log.info("MCU: Aborting active server side debugging session.");
                    }
                    break;
                }
            }
        }

    })

    function consolidate_mcu_nodes(with_ui_support) {

        // Select the nodes to build flows.json
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

                // ToDo: We have to find an alternative logic for this!!
                let running_node = RED.nodes.getNode(n.id);
                running_node?.emit("mcu:plugin:build:prepare", n, nodes);

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

        // Remove Link Out/In nodes & Junctions
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

                case "junction":
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
                    // Regex as proposed by Steve: https://github.com/ralphwetzel/node-red-mcu-plugin/commit/0cb67f85262705e2c812df6819e3ebd511189d20#commitcomment-132987108
                    if (key!=="id" && key!=="z" && key!=="type" && typeof(ok)==="string" && ok.match(/^[0-9a-f]{8}\.?[0-9a-f]{3,8}$/i)) {
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
        for (let key in configNodes) {
            if (configNodes[key].mcu === true) {
                nodes.push(configNodes[key].node);
            }
        }

        nodes.forEach((node) => {

            // check if this node manages credentials
            let n = RED.nodes.getNode(node.id);
            if (n) {
                if (n.credentials) {

                    // node._mcu ??= {};    // <= node 15+

                    if (!node._mcu) {
                        node._mcu = {};
                    }

                    node._mcu["credentials"] = clone(n.credentials);
                }
            }

        })

        // Add UI support
        if (with_ui_support) {

            // add ui_base node to the group of nodes to be exported!
            if (!ui_base) {

                // There might be situations where ui_base was deleted in the editor;
                // rather than throwing here, we try to create a minimal / standard replacement node

                ui_base = {
                    id: RED.util.generateId(),
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
        }

        return nodes;
    }

    function make_build_environment(nodes, working_directory, options) {

        // Create target directory
        let dest = working_directory ?? fs.mkdtempSync(path.join(os.tmpdir(), app_name));
        fs.ensureDirSync(dest);

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

        switch (options._mode) {
            case "mod":
                manifest.include_manifest("$(MODDABLE)/examples/manifest_mod.json");
                break;
            default:
                manifest.include_manifest("$(MCUROOT)/manifest_host.json");
        
        }


        // resolve core nodes directory => "@node-red/nodes"
        for (let i=0; i<manifest.resolver_paths.length; i+=1) {
            let pp = resolve_package_path("@node-red/nodes", manifest.resolver_paths[i]);
            if (pp) {
                manifest.add_build("REDNODES", path.dirname(pp));
            }
        }

        let nodes_demanding_ui_support = 0;

        // *****
        // Map Node-RED node definitions to node-red-mcu core manifest.json files

        // Check directories in node-red-mcu/nodes
        // Latest check: 20221221/RDW

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
        // split => core
        // tcp => core
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
            "split": "split",
            "tcp in": "tcp",
            "tcp out": "tcp",
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

        // UI_Nodes support
        // Check if ui_nodes need to be supported
        // This has to be done upfront as ui_base might already be in the nodes array ...
        // ... and we need to remove it (in case it's not needed) before enumerating the manifest.json(s)
        {
            let nodes_demanding_ui_support = 0;

            nodes.forEach((n) => {
                let node = library.get_node(n.type);
                if (!node) return;
                let module = node.module;
                if (!module) return;

                if (module === "node-red-dashboard" && n.type !== "ui_base") {
                    if (!options.ui) {
                        throw Error("This flow uses UI nodes - yet UI support is diabled. Please enable UI support.")
                    }
                    nodes_demanding_ui_support += 1;
                }
            })

            if (nodes_demanding_ui_support < 1) {

                // If the operator sets "UI Support" despite it's not necessary,
                // ui_base was already added.
                // Thus we remove it here again if present - as not necessary!
                let i = nodes.findIndex( (n) => { 
                    return "ui_base" == n.type; 
                })
                if (-1 < i) {
                    nodes.splice(i, 1);
                }

            }
        }

        // To prepare main.js
        let mainjs_additional_imports = [];

        let type2manifest = {}; 
        try {
            type2manifest = require(path.join(rmp, "node_types.json"));
        } catch {}

        // In case a node maintains credentials,
        // we'll collect them here & save to credentials.json
        let credentials = {}

        nodes.forEach(function (n) {

            // care for the credentials first
            if (n._mcu?.credentials) {
                credentials[n.id] = clone(n._mcu.credentials);
                delete n._mcu.credentials;
            }

            // check _mcu for any manifest information defind
            if (n._mcu?.manifest?.trim?.().length > 0) {
                // Write the flow's manifest.json
                fs.writeFileSync(path.join(dest, `manifest_${n.id}.json`), n._mcu.manifest.trim(), (err) => {
                    if (err) {
                        throw err;
                    }
                });
                manifest.include_manifest(`./manifest_${n.id}.json`)
            }

            if (n._mcu?.include && Array.isArray(n._mcu.include)) {
                n._mcu.include.forEach(function(m) {
                    manifest.include_manifest(m);
                });
            }

            if (n._mcu?.modules) {
                try {
                    n._mcu.modules.keys().forEach(function(k) {
                        manifest.add_module(n._mcu.modules[k], k);
                    })
                } catch(err) {
                    throw err;
                }
            }

            // clean the config from the _mcu flag
            if (n._mcu) {
                delete n._mcu;
            }

            // verify that a manifest is available, create stubs for missing ones
            let node = library.get_node(n.type);
            if (!node) return;

            let module = node.module;
            if (!module) return;
            
            if (n.type in type2manifest) {
                
                // let mp = type2manifest[n.type];

                // if (mp.length > 0) {
                //     manifest.include_manifest(`$(MCUROOT)/${type2manifest[n.type]}`);
                // }

                return;
            }

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

            // } else if (module === "node-red-dashboard") {
            //     throw Error(`manifest.json for node type '${module}' is missing.`)

            } else if (module.indexOf("node-red-node-ui-") === 0) {
                throw Error(`Node type '${module}' currently not supported on MCU.`)
            }

            if (manifest.resolver_paths.indexOf(node.path) < 0) {
                manifest.resolver_paths.push(node.path)
            }

            let p = manifest.get_manifest_of_module(module, dest, n.type);
            if (p && typeof(p) === "string") {
                manifest.include_manifest(p);
                return;
            }
            p = manifest.create_manifests_for_module(module, dest, n.type)
            if (p && typeof(p) === "string") {
                manifest.include_manifest(p);
                mainjs_additional_imports.push(module);
            }

        });

        // Check if there is any node to be build
        if (nodes.length < 1) {
            throw Error("No flow to build.")
        }

        // // UI_Nodes support
        // let app_options;
        // if (options.ui && nodes_demanding_ui_support > 1) {

        //     if ("mod" !== options._mode) {
        //         // Dedicated includes
        //         manifest.include_manifest("$(MCUROOT)/nodes/ui/manifest.json");

        //         // @ToDo: Check if really necessary!
        //         manifest.include_manifest("$(MCUROOT)/nodes/random/manifest.json");
        //         manifest.include_manifest("$(MCUROOT)/nodes/trigger/manifest.json");
        //     }

        //     app_options = {
        //         commandListLength: options.cll,
        //         displayListLength: options.dll,
        //         touchCount: options.tc,
        //         pixels: options.px * options.py
        //     }

        // } else {
        //     // If the operator sets "UI Support" despite it's not necessary,
        //     // ui_base was already added.
        //     // Thus we remove it here again if present - as not necessary!
        //     let i = nodes.findIndex( (n) => { 
        //         return "ui_base" == n.type; 
        //     })
        //     if (-1 < i) {
        //         nodes.splice(i, 1);
        //     }

        //     nodes_demanding_ui_support = 0;
        // }

        // Create main.js
        let mainjs = fs.readFileSync(path.join(__dirname, "./templates/main.js.eta"), 'utf-8');

        mainjs = Eta.render(mainjs,
        {
            imports: mainjs_additional_imports ?? [],
            cll: options.cll ?? 4096,
            dll: options.dll ?? 4096,
            tc: options.tc ?? 1,
            pixels: options.px * options.py ?? (240*32)
        })        

        if (options._mode !== "mod") {
            // Write the main.js file
            fs.writeFileSync(path.join(dest, "main.js"), mainjs, (err) => {
                if (err) {
                    throw err;
                }
            });

            manifest.add_module("./main")
            manifest.add_preload("flows");
            
        }
        
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

        if (options._mode !== "mod") {
            // currently omit for Mods
            if (options?.creation) {
                let c = JSON.parse(options.creation)
                manifest.add(c, "creation");
            }
        }

        // prevent setting config arguments via the command line!
        {
            let args = {};

            if (options?.arguments) {
                args = JSON.parse(options.arguments);
            }

            if (options.ssid) {
                args['ssid'] = options.ssid;
            }
            if (options.password) {
                args['password'] = options.password;
            }

            if (options._mode !== "mod") {
                
                // enable editor message transmission by the MCU
                args['noderedmcu'] = {
                    'editor': true
                }
            }

            manifest.add(args, "config");
        }

        let m = manifest.get();

        // Write the (root) manifest.json
        fs.writeFileSync(path.join(dest, "manifest.json"), manifest.get(), (err) => {
            if (err) {
                throw err;
            }
        });

        // when everything else succeeded:
        // write the credentials
        // https://github.com/ralphwetzel/node-red-mcu-plugin/issues/28#issuecomment-1460880983
        if (Object.keys(credentials).length > 0) {
            fs.writeFileSync(path.join(dest, "flows_cred_mcu.json"), JSON.stringify({ "credentials": credentials }), (err) => {
                if (err) {
                    throw err;
                }
            });
        }

        return dest;
    
    }

    function make_host_environment(nodes, working_directory, options) {

        // Create target directory
        let dest = working_directory ?? fs.mkdtempSync(path.join(os.tmpdir(), app_name));
        fs.ensureDirSync(dest);

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
        manifest.include_manifest("$(MCUROOT)/manifest_host.json")

        // Create main.js
        let mainjs = fs.readFileSync(path.join(__dirname, "./templates/main_mod_host_ui_js.eta"), 'utf-8');

        mainjs = Eta.render(mainjs,
        {
            cll: options.cll ?? 4096,
            dll: options.dll ?? 4096,
            tc: options.tc ?? 1,
            pixels: options.px * options.py ?? (240*32)
        })        

        if (options.ui) {        
            manifest.include_manifest("$(MCUROOT)/manifest_ui.json")
        }

        // Write the main.js file
        fs.writeFileSync(path.join(dest, "main.js"), mainjs, (err) => {
            if (err) {
                throw err;
            }
        });

        manifest.add_module("./main");
        manifest.add_preload("flows");

        // enable editor message transmission by the MCU
        let editor_transmission_on = { "noderedmcu": { "editor": true }};
        manifest.add(editor_transmission_on, "config");

        // enable Mods
        manifest.add({ "XS_MODS": 1 }, "defines");

        // add strip definition
        let strips = [
            "Atomics",
            "eval",
            "FinalizationRegistry",
            "Function",
            "Generator",
            // "RegExp",
            "WeakMap",
            "WeakRef",
            "WeakSet"
        ]
        manifest.add(strips, "strip");

        if (options?.creation) {
            let c = JSON.parse(options.creation)
            manifest.add(c, "creation");
        }

        let m = manifest.get();

        // Write the (root) manifest.json
        fs.writeFileSync(path.join(dest, "manifest.json"), manifest.get(), (err) => {
            if (err) {
                throw err;
            }
        });

        return dest;

    }

    function build_flows(nodes, options, publish) {

        options = options ?? {};

        function _publish() {}
        publish = publish ?? _publish;

        function publish_stdout(msg) {
            publish("mcu/stdout/test", msg, false); 
        }

        function publish_stderr(msg) {
            publish("mcu/stdout/test", msg, false); 
        }

        publish_stdout("Starting build process...\n")
        publish_stdout(`Host system check: ${os.version()}\n`);

        let x_win = __VERSIONS__.x_win;

        if (x_win) {
            publish_stdout(`MCU Build system check: p${__VERSIONS__.plugin} + #${__VERSIONS__.runtime} @ m${__VERSIONS__.moddable} (${"32" === x_win ? "x86" : "x64"})\n` );
        } else {
            publish_stdout(`MCU Build system check: p${__VERSIONS__.plugin} + #${__VERSIONS__.runtime} @ m${__VERSIONS__.moddable}\n` );
            if (os.platform() === "win32") {
                x_win = "x86";
                publish_stdout(`Unable to determine if Windows OS is 32-bit (x86) or 64-bit (x64); forcing to (${x_win}).\n` );
            }
        }

        publish_stdout(`HOME directory check: ${os.homedir()}\n`);

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

                // ensure the correct path separators
                n = path.normalize(n);
                
                publish_stdout(`$${name} is defined: ${n}\n`)

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

            // ensure the correct path separators
            n = path.normalize(n);

            // path_options can declare as well a file to be checked for existance
            // to be more precise in defining what we expect as "fingerprint" of the env variable setting 
            let stat;
            try {
                stat = fs.statSync(n);
            } catch {}

            if (stat?.isFile()) {
                n = path.dirname(n);
            }

            publish_stdout(`$${name} identified: ${n}\n`);
            return n;
        }

        publish_stdout(`Creating build environment for platform ${options.platform}.\n`)

        // Define local dir as working_directory based on options.id

        let make_dir = path.join(RED.settings.userDir, "mcu-plugin-cache", `${options.id}${(['host', 'mod'].includes(options._mode)) ? ('-' + options._mode) : ""}`);
        
        // only preliminary for testing!!
        fs.emptyDirSync(make_dir)

        try {
            switch (options._mode) {
                case "host":
                    publish_stdout(`Creating build environment for a host to run mods.\n`)
                    make_host_environment(nodes, make_dir, options);
                    break;
                case "mod":
                    publish_stdout(`Creating build environment for a mod.\n`)
                    // work done by make_build_environment
                default:
                    make_build_environment(nodes, make_dir, options);
            }
        } catch (err) {
            publish_stderr(err.toString() + "\n");
            return Promise.reject(err);
        }

        publish_stdout(`Working directory: ${make_dir}\n`);

        let env = {
            "HOME": os.homedir(),
            "SHELL": process.env.SHELL,
            "PATH": process.env.PATH,
            "MODDABLE": MODDABLE,
            "FONTBM": process.env.FONTBM,
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

        try {
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

                    if (os.platform() == "win32") {
                        env.IDF_TOOLS_PATH = ensure_env_path("IDF_TOOLS_PATH", [
                            `${process.env["USERPROFILE"]}\\.espressif`,
                            `C:\\Espressif`
                        ]);
                        env.LOCALAPPDATA =  ensure_env_path("LOCALAPPDATA", [
                            `${process.env["USERPROFILE"]}\\AppData\\Local`
                        ]);
                    } else {
                        try {
                            // This one is a bit different: Take it if defined, yet don't care if not!
                            env.IDF_TOOLS_PATH = ensure_env_path("IDF_TOOLS_PATH", [
                                `${HOME}/.espressif`,
                            ]);
                        } catch(err) {
                            publish_stdout(err.toString() + '\n');
                        }
                    }

                    // RDW
                    // Introduced in 12/2022, removen in 11/23
                    // pro: https://github.com/phoddie/node-red-mcu/discussions/46#discussioncomment-4443559
                    // against: https://discourse.nodered.org/t/mcu-plugin-tooling-works-from-a-shell-but-not-from-the-plugin-sidebar/82457/9
                    
                    // try {
                    //     // This one is a bit different: Take it if defined, yet don't care if not!
                    //     env.IDF_PYTHON_ENV_PATH = ensure_env_path("IDF_PYTHON_ENV_PATH", []);
                    // } catch(err) {
                    //     publish_stdout(err.toString() + '\n');
                    // }

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
                case "nrf52":
                    switch (os.platform()) {
                        case "win32":
                            env.NRF52_SDK_PATH = ensure_env_path("NRF52_SDK_PATH", [`${HOME}/nrf5/nRF5_SDK_17.0.2_d674dde`]);
                            break;
                        case "linux": 
                        case "darwin":
                            env.NRF_SDK_DIR = ensure_env_path("NRF_SDK_DIR", [`${HOME}/nrf5/nRF5_SDK_17.0.2_d674dde`]);
                            break;
                        }
                    break;  
                case "sim":
                    break;
                default:
                    throw(`Invalid platform identifier given: ${pid}`);
            }
        } catch (err) {
            return Promise.reject(err);
        }

        let cmd = options._mode == "mod" ? "mcrun" : "mcconfig"

        if (options.debug === true) {
            cmd += " -d";
            cmd += ` -x localhost:${proxy_port_mcu}`

            if (options.debugtarget == "1") {
                cmd += " -l"
            }
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

        if (cmd !== "mcrun") {
            // no -t option for mcrun
            if (options.buildtarget) {
                cmd += " -t " + options.buildtarget;
            }    
        }

        // {
        //     let args = {};
        //     if (options.arguments) {
        //         args = JSON.parse(options.arguments);
        //     }
        //     if (options.ssid) {
        //         args['ssid'] = options.ssid;
        //     }
        //     if (options.password) {
        //         args['password'] = options.password;
        //     }

        //     for (key in args) {
        //         cmd += ` ${key}='"${args[key]}"'`
        //     }
        // }

        let runner_options = {
            "cwd": make_dir,
            "env": env
        };

        publish_stdout(`> cd ${make_dir}\n`);

        let bcmds = [
            '#!/bin/bash',
            'runthis(){',
            '   echo ">> $@"',
            '   eval "$@"',
            '}',
        ]

        switch (pid) {

            /* Not tested! */
            case "pico":
            case "gecko":
            case "qca4020":
            /* Not tested! */

            case "nrf52":
            case "sim":

                bcmds.push(`runthis ${cmd}`);
                break;
                
            case "esp":

                env['UPLOAD_PORT'] = options.port;
                publish_stdout(`UPLOAD_PORT = ${env['UPLOAD_PORT']}\n`);

                bcmds.push(...[
                    `runthis ${cmd}`
                ])

                break;

            case "esp32":

                // mcrun looks for the UPLOAD_PORT with support of a python script.
                // "python" yet may not be on the path thus the call has a potential to throw.
                // => Ensure to set the UPLOAD_PORT to circumnavigate this python script...
                // ... otherwise we needed to source export.sh or take another action to ensure "python" can be found!

                env['UPLOAD_PORT'] = options.port;
                publish_stdout(`UPLOAD_PORT = ${env['UPLOAD_PORT']}\n`);

                // debugging for https://discourse.nodered.org/t/mcu-plugin-tooling-works-from-a-shell-but-not-from-the-plugin-sidebar/82457
                
                publish_stdout(`IDF_TOOLS_EXPORT_CMD = ${env['IDF_TOOLS_EXPORT_CMD']}\n`);
                publish_stdout(`IDF_PYTHON_ENV_PATH = ${env['IDF_PYTHON_ENV_PATH']}\n`);
                publish_stdout(`OPENOCD_SCRIPTS = ${env['OPENOCD_SCRIPTS']}\n`);
                publish_stdout(`ESP_IDF_VERSION = ${env['ESP_IDF_VERSION']}\n`);

                if (os.platform() === "win32") {
                    // execFile doesn't expand the env variables... ??
                    bcmds = [
                        `CALL "${process.env["ProgramFiles"]}\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars${x_win}.bat"`,
                        'pushd %IDF_PATH%',
                        `CALL "${process.env["IDF_TOOLS_PATH"]}\\idf_cmd_init.bat"`,
                        'popd',
                        `@echo ${cmd}`,
                        `${cmd}`,
                    ]
                } else {

                    // See remark above cencerning UPLOAD_PORT!
                    if (options._mode !== "mod") {
                        bcmds.push(
                            'runthis "source \"$IDF_PATH/export.sh\""'
                        )
                    }

                    bcmds.push(...[
                        'echo ">> IDF_PYTHON_ENV_PATH: $IDF_PYTHON_ENV_PATH"',
                        `runthis ${cmd}`
                    ])

                }
                break;
        }

        let run_cmd;

        runner_abort = new AbortController();
        runner_options["signal"] = runner_abort.signal;

        let pe_us = process.env.UPLOAD_SPEED;
        if (pe_us) {
            env["UPLOAD_SPEED"] = pe_us;
            publish_stdout(`UPLOAD_SPEED = ${pe_us}\n`);
        }

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
                runner_options["shell"] = true;

                // https://stackoverflow.com/questions/46072248/node-js-how-to-detect-user-language
                let locale = Intl.DateTimeFormat().resolvedOptions().locale;
                switch (locale) {
                    case "de-DE":       // this is 'de' on masOS
                        runner_options['encoding'] = "latin1";
                        break;
                    case "ja-JP":
                        bcmds.unshift(`chcp 437`);
                        break;
                    default:
                        runner_options['encoding'] = "utf8";
                }

                publish_stdout("Creating build batch file...\n")
                fs.writeFileSync(path.join(make_dir, "build.bat"), bcmds.join("\r\n"))
                bcmds = ["build.bat"];

                run_cmd = filename => new Promise((resolve, reject) => {

                    publish_stdout(`> cmd.exe ${filename}\n`);

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

                env["DISPLAY"] = ":0.0";
                
            case "darwin":

                publish_stdout("Creating build script file...\n")
                fs.writeFileSync(path.join(make_dir, "build.sh"), bcmds.join("\n"))
                bcmds = ["./build.sh"];

                run_cmd = filename => new Promise((resolve, reject) => {

                    publish_stdout(`> /bin/bash ${filename}\n`);

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

                    publish_stdout(`> ${cmd}\n`);
        
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
                
                let options = req.body.options
                if (!options) {
                    res.status(400).end();
                    return;
                }

                let mode = req.body.mode;

                // final guard for build
                if (!(MCU_EXPERIMENTAL & 1)) {
                    if (["host", "mod"].includes(mode)) {
                        throw "You need to define 'process.env.MCU_EXPERIMENTAL = 1' to enable Mod Support.";
                    }
                }

                options._mode = mode ?? "";

                if (mode === "reconnect") {
                    options.buildtarget = "xsbug";
                }

                let nodes = consolidate_mcu_nodes(options.ui);

                // *** Is this a valid assumption?
                if (!options.make) {
                    options.make = true;
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

                // proxy = new mcuProxy.proxy(proxy_port_mcu, "1" === options.debugtarget ? proxy_port_xsbug_log: proxy_port_xsbug);
                proxy = new mcuProxy.proxy(proxy_port_mcu, proxy_port_xsbug);

                proxy.on("status", (id, data) => 
                    mcuRelay.status(id, data)
                )

                proxy.on("input", (id, data) => 
                    mcuRelay.input(id, data)
                )

                proxy.on("error", (id, data) => 
                    mcuRelay.error(id, data)
                )

                proxy.on("warn", (id, data) => 
                    mcuRelay.warn(id, data)
                )

                proxy.on("mcu", (data) => 
                    mcuRelay.mcu(data)
                )

                try {
                    runner_promise = build_flows(nodes, options, RED.comms.publish)
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
                    "ports": mcu_plugin_config.ports,
                    "experimental": MCU_EXPERIMENTAL ?? 0
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
            RED.httpAdmin.post(`${apiRoot}/backproxy`, routeAuthHandler, (req, res) => {
                let msg;

                if (req.body && req.body.msg) {
                    msg = req.body.msg
                }

                console.log(msg.type);
                
                if (msg && mcuRelay[msg.type]) {
                    mcuRelay[msg.type](msg.id, msg.data);
                }

                res.status(200).end();

            })

            RED.httpAdmin.post(`${apiRoot}/localflash`, routeAuthHandler, (req, res) => {
                let options;
                if (req.body && req.body.options) {
                    options = req.body.options
                } else {
                    RED.log.error(`${app_name}: Failed to parse incoming config data.`);
                    res.status(400).end();
                    return;
                }

                let mode = req.body.mode;

                options._mode = mode ?? "";

                options.buildtarget = "build";

                let nodes = consolidate_mcu_nodes(options.ui);

                options.make = true;

                // abort the currently running runner
                if (runner_promise && runner_abort) {
                    // console.log("Aborting...")
                    runner_abort.abort();
                    delete runner_promise;
                    delete runner_abort;
                }

                try {
                    runner_promise = build_flows(nodes, options, RED.comms.publish)
                    .then( () => {

                        let version = "debug";
                        if (options.release === true) {
                            version = "relese";
                        }
                        
                        let pp = path.join(MODDABLE, "build", "bin", options.platform, version, options.id);
                        if (!fs.existsSync(pp)) {
                            RED.comms.publish("mcu/stdout/test", "bin data directory not found.", false);
                        }
        
                        let files = {
                            "bl": "bootloader.bin",
                            "pt": "partition-table.bin",
                            "xs": "xs_esp32.bin"
                        }
        
                        let not_found = false;
                        for (f in files) {
                            let file = files[f];
                            let fp = path.join(pp, file);
        
                            if (!fs.pathExistsSync(fp)) {
                                not_found = true;
                                files[f] = undefined;
                                continue;
                            }
        
                            let fb = fs.readFileSync(fp);
                            // files[f] = fb.toJSON();
                            files[f] = fb.toString("binary");
                        }
        
                        if (not_found) {
                            res.status(500).end();    
                        }
        
                        res.status(200).end(JSON.stringify(files), "utf8");    
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

            })

        }
    });
}
