import Modules from "modules";

function require(module) {

    let req = Modules.importNow(module);

    if (req?.default)
        return req.default;

    return req;

}

globalThis.require = require;
