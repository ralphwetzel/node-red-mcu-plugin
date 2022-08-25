import Modules from "modules";

// function generateMyId() @ "xs_nodered_util_generateId_X";

// eslint-disable-next-line
function importNow() @ "rdw_mcu_importNow";

async function require(module) {

    // trace("@generateMyId: ", generateMyId(), "\n");

    trace("@require: ", module, "\n");
    trace("@require: has?", Modules.has(module), "\n");
    debugger;

    try {
        // const mod = Modules.importNow(module);
        const mod = importNow(module);
        trace("@require -> after await: ", module, "\n");
        return mod;
     }
    catch (err) {
        trace("@require: ", err, "\n");
        return;
    }
}

globalThis.require = importNow;
