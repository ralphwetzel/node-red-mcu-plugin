const clone = require("clone")
const path = require("path");
const fs = require("fs-extra");
// const pkgContents = require('@npmcli/installed-package-contents')


// RDW 20220821: https://github.com/ai/nanoid/issues/364
// There's a BREAKING CHANGE @nanoid.v4 supporting only ES6. Thus we stick to v<4!
const { customAlphabet } = require('nanoid');

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const nanoid = customAlphabet(alphabet, 16);

// https://github.com/stefanpenner/resolve-package-path
const resolve_package_path = require('resolve-package-path')

class manifest_builder {

    // supported options: {
    //    preload: Add module to preload list
    // }

    constructor(library, mcu_modules_path, options) {
        if (!library || !mcu_modules_path) {
            throw ("manifest_builder: Mandatory constructor arguments missing.")
        }
        this.nodes_library = library
        this.mcu_modules_path = mcu_modules_path;
        this.manifest = {};
        this.resolver_paths = [];
        this.options = options ?? {};
        this.initialize();
    }

    initialize(init) {
        if (typeof(init) === "string") {
            this.manifest = JSON.parse(init);
        } else if (typeof(init) === "object"){
            this.manifest = clone(init);
        }
        return true;
    }

    get_manifest_of_module(module, optional_path, node_type) {

        // console.log(`Trying to find 'manifest.json' for module "${module}":`);

        if (typeof(optional_path) !== "string") {
            throw 'typeof(optional_path) has to be "string"!'
        }

        let package_path;

        for (let i=0; i<this.resolver_paths.length; i+=1) {
            package_path = resolve_package_path(module, this.resolver_paths[i]);
            if (package_path) {
                break;
            }
        }
        
        if (!package_path) {
            throw `Unable to resolve path for module "${module}".`;
        }

        let module_path = path.dirname(package_path);

        let paths_to_check = [];

        // If a node_type is given: Let's ask the module first!
        if (node_type) {

            let pckge = require(package_path);
            if (!pckge) {
                // Shall never happen!
                return;
            }

            // check if there's a node-red section in package.json?
            let nds = pckge["node-red"]?.nodes;
            if (nds) {
                let _entry;
                // if so, check if there's an entry declared for this node type!
                if (nds[node_type]) {
                    _entry = nds[node_type];
                } else {
                    let ndsk = Object.keys(nds);
                    // if there's only one entry we assume this is the correct one!                
                    if (ndsk.length === 1) {
                        _entry = nds[ndsk[0]];
                    }
                }
                if (_entry) {
                    
                    // try to check for the given path
                    let _path = path.join(module_path, _entry);

                    try {
                        if (fs.lstatSync(_path).isFile()) {
                            _path = path.dirname(_path);
                        }
                    } catch {
                        // path does not exist?
                        _path = undefined;
                    }

                    if (_path && _path.length > 0) {
                        // we wish to have the manifest.json in the /mcu subdirectory 
                        paths_to_check.push(path.join(_path, "mcu"));
                        // ... but accept it as well in the root
                        paths_to_check.push(_path);
                    }
                }
            }

        }

        // A very convenient situation: there is a manifest for this node type!
        paths_to_check.push(path.join(module_path, "mcu"))
        
        // This is deprecated: accept as well a "manifest.json" in the nodes root directory
        paths_to_check.push(module_path);

        // Next best: We've a manifest template provided predefined in our mcu_modules folder
        let scoped_module = module.split("/");
        paths_to_check.push(path.join(this.mcu_modules_path, ...scoped_module));

        // Perhaps there's already a manifest.json in the (optionally) provided path
        if (optional_path) {
            paths_to_check.push(path.join(optional_path, ...scoped_module))
        }

        for (let i=0; i<paths_to_check.length; i+=1) {
            let p = path.join(paths_to_check[i], "manifest.json");
            if (fs.existsSync(p)) {
                let mnfst = require(p);
                if (mnfst["//"]?.template !== undefined) {
                    // don't accept templates
                    continue;
                } else {
                    // console.log(`"manifest.json" found @ ${p}`);
                    return p;    
                }
            }
        }
        return;
    }

    include_manifest(path) {
        if (!this.manifest) {
            throw "Missing base manifest @ include_manifest"
        }
        if (!this.manifest.include) {
            this.manifest.include = [];
        }

        if (this.manifest.include.indexOf(path) < 0) {
            this.manifest.include.push(path);
            return true;
        }
        
        return false;
    }

    create_manifests_for_module(module, destination, node_type) {

        // console.log(`Creating 'manifest.json' for module "${module}":`);

        let package_path;

        for (let i=0; i<this.resolver_paths.length; i+=1) {
            package_path = resolve_package_path(module, this.resolver_paths[i]);
            if (package_path) {
                break;
            }
        }
        
        if (!package_path) {
            throw `Unable to resolve path for module "${module}".`;
        }

        let pckge = require(package_path);
        // ToDo: Send sth to console
        if (!pckge) return;

        // console.log(pckge);

        // split the module name to get its scope
        let scoped_module = module.split("/");

        // check if there is a template in mcu_nodes
        let template_path = path.join(this.mcu_modules_path, ...scoped_module, "manifest.json");
        let mnfst_template;
        let template;
        if (fs.existsSync(template_path)) {
            mnfst_template = require(template_path);
            template = mnfst_template["//"]?.template;
            if (template === undefined) {
                // sorry... this is not a template!
                mnfst_template = undefined;
            }
        }

        // console.log(mnfst_template);

        // This is the name of the module that we need to make available
        // We could use module here as well ... ??
        let _module = pckge.name;

        let _file;

        // #0: if we got a node_type defined:
        if (node_type) {
            // check if there's a node-red section in package.json?
            let nds = pckge["node-red"]?.nodes;
            if (nds) {
                // if so, check if there's a file declared for this node type!
                if (nds[node_type]) {
                    _file = nds[node_type];
                } else {
                    let ndsk = Object.keys(nds);
                    // if there's only one entry we assume this is the correct file!                
                    if (ndsk.length === 1) {
                        _file = nds[ndsk[0]];
                    }    
                }
            }
        }

        // *****
        // ToDo & Attention!
        //      There's an edge case when there're several node_types defined in one module
        //      & we try to create a (separate) manifest.json for more than one of them.
        //      This will - most probably - not work as intended & lead to a runtime error
        //      ... as only the first manifest.json will be generated.
        // *****

        // #1: exports.import (as we prefer to be "import"ed modules)
        // #2: exports.require (despite this will create issues...)
        // #2: main - which is most likely == exports.require
        // default acc. doc: "./index.js" if main not defined
        _file = _file 
            ?? pckge.exports?.import
            ?? pckge.exports?.require 
            ?? pckge.main 
            ?? "./index.js";
        
        // Few modules define more than one entry point.
        // In this case, try to get the 'default' entry
        if (_file instanceof Object) {
            _file = _file.default;
        }

        // No _file found
        if (_file === undefined) {
            throw Error(`Could not determine entry point for module ${module}.`)
        }

        // _file was defined w/ "". Treat this as "there's no entry point"!
        // This may be the case for "@types" files.
        if (_file === "") {
            console.log(`${_module}: Skipped as package entry point voided.`)
            return;
        }
        
        let _path = path.resolve(path.dirname(package_path), _file);

        if (fs.pathExistsSync(_path)) {
            // check if it is a dir
            if (fs.lstatSync(_path).isDirectory()) {
                _path = path.resolve(_path, "./index.js")
            }
        } else {
            if (path.extname(_path).length < 1) {
                _path += ".js";
            }
        }
        
        if (fs.pathExistsSync(_path) !== true) {
            console.log("Path not found: " + _path);
            return;
        }

        // prepare the dir for this manifest
        let mnfst_path = path.join(destination, ...scoped_module, "manifest.json");
        fs.ensureDirSync(path.dirname(mnfst_path));

        /*  template: {
        *       "modules": ['name of module to be resolved & included', 'another name', '* == all']
        *   }
        */
        function check_template(section, key) {
            if (!template) return true;

            let keys = template[section] ?? []
            for (let i = 0; i < keys.length; i++) {
                if (keys[i] === key || keys[i] == "*") {
                    return true;
                }
            }
            return false;
        }

        // make module path & create symlink if necessary
        if (check_template("modules", _module)) {

            let _ext = "";
            let _p = _path
            let _pp;
            let _name;
    
            do {
                _name = _pp?.name ?? "";
                _pp = path.parse(_p)
                // console.log(_pp);
                _ext = _pp.ext + _ext;
                _p = _p.slice(0, -_ext.length);
            } while (_pp.ext !== "")
    
    
            // Moddable will only resolve ".js" files
            // In case the extension is sth else, create a symlink
            if (_ext !== ".js") {
                
                let _link;
                do {
                    _link = `${_name}-${_ext.replace(/\./g, "")}-${nanoid()}.js`
                    _link = path.join(path.dirname(mnfst_path), _link)    
                } while (fs.existsSync(_link));
    
                fs.symlinkSync(_path, _link);
                _path = _link;
            }    
        }

        let mnfst = {
            "//": {
                "***": "https://github.com/ralphwetzel/node-red-mcu-plugin",
                "npm": `${module}`,
                "xs": "manifest.json",
                "@": `${new Date(Date.now()).toJSON()}`,
                "ref": "https://github.com/Moddable-OpenSource/moddable"
            },
            "build": {},
            "include": [],
            "modules": {
                "*": [],
            }
        }

        let bldr = new manifest_builder(this.nodes_library, this.mcu_modules_path, this.options);
        // console.log(bldr);

        if (mnfst_template) {
            
            // if we don't clone here, we'll get the modified mnfst @ the next require call! 
            let mt = clone(mnfst_template)

            // this eliminates the "template" property of mt/mnfst_template!
            mt["//"] = clone(mnfst["//"]);
            
            // to be sure...
            mt.build = mt.build || {};
            mt.include = mt.include || [];
            mt.modules = mt.modules || { "*": [] };

            bldr.initialize(mt);
        } else {
            bldr.initialize(clone(mnfst));
        }

        bldr.resolver_paths = this.resolver_paths;

        let _MCUMODULES = false
        if (check_template("build", "MCUMODULES")){
            // first: define MCUMODULES
            bldr.add_build("MCUMODULES", this.mcu_modules_path);
            _MCUMODULES = true;
        }

        if (check_template("build", "REDNODES")){
            // resolve core nodes directory => "@node-red/nodes"
            for (let i=0; i<this.resolver_paths.length; i+=1) {
                let pp = resolve_package_path("@node-red/nodes", this.resolver_paths[i]);
                if (pp) {
                    bldr.add_build("REDNODES", path.dirname(pp));
                }
            }
        }

        if (check_template("include", "require")){
            // Make "require" available
            let _require = _MCUMODULES ? "$(MCUMODULES)" : this.mcu_modules_path
            bldr.include_manifest(`${_require}/require/manifest.json`);
        }

        if (check_template("modules", _module)) {
            // explicitely add with the import name and the path (or symlink)
            let _pp = path.parse(_path);
            if (_pp.ext.length > 0) {
                _path = _path.slice(0, -_pp.ext.length);
            }
            bldr.add_module(_path, _module);

            if (this.options?.preload === true) {
                bldr.add_preload(_module);
            }
        }

        // Write this initial manifest to disc
        // to ensure that it's found on further iterations
        // thus to stop the iteration!
        // console.log(mnfst_path);
        // console.log(bldr.get());

        fs.writeFileSync(mnfst_path, bldr.get(), (err) => {
            if (err) {
                throw err;
            }
        });

        let changed = false;

        // console.log(`Checking dependencies of module "${module}":`);

        let deps = pckge.dependencies;
        if (deps) {
            for (let key in deps) {
                if (check_template("include", key)) {
                    let mnfst = this.get_manifest_of_module(key, destination);
                    if (mnfst && typeof (mnfst) === "string") {
                        bldr.include_manifest(mnfst);
                        changed = true;
                        continue;
                    }
                    mnfst = this.create_manifests_for_module(key, destination);
                    if (mnfst && typeof(mnfst) === "string") {
                        bldr.include_manifest(mnfst);
                        changed = true;
                    }
                }
            }
        }

        if (changed === true) {
            fs.ensureDirSync(path.dirname(mnfst_path));
            fs.writeFileSync(mnfst_path, bldr.get(), (err) => {
                if (err) {
                    throw err;
                }
            });    
        }

        return mnfst_path;
    }


    from_template(module, destination) {

        // ToDo: Merge w/ outer functinality

        function check_template(t, section, key) {
            if (!t) return false;

            let keys = t[section] ?? []
            for (let i = 0; i < keys.length; i++) {
                if (keys[i] === key || keys[i] == "*") {
                    return true;
                }
            }
            return false;
        }

        let self = this;

        // split the module name to get its scope
        let scoped_module = module.split("/");

        // prepare the dir for this manifest
        let mnfst_path = path.join(destination, ...scoped_module, "manifest.json");
        fs.ensureDirSync(path.dirname(mnfst_path));
                
        // check if there is a template in mcu_nodes
        let template_path = path.join(self.mcu_modules_path, ...scoped_module, "manifest.json");
        if (!fs.existsSync(template_path))
            return;

        let mnfst_template = require(template_path);
        let template = mnfst_template["//"]?.template;
        if (template === undefined) {
            // sorry... this is not a template!
            return;
        }

        let mt = clone(mnfst_template);
        delete mt["//"].template;
        let bldr = new manifest_builder(self.nodes_library, self.mcu_modules_path, this.options);
        bldr.initialize(mt);


        let _MCUMODULES = false
        if (check_template(template, "build", "MCUMODULES")){
            // first: define MCUMODULES
            bldr.add_build("MCUMODULES", self.mcu_modules_path);
            _MCUMODULES = true;
        }

        if (check_template(template, "build", "REDNODES")){
            // resolve core nodes directory => "@node-red/nodes"
            for (let i=0; i<this.resolver_paths.length; i+=1) {
                let pp = resolve_package_path("@node-red/nodes", self.resolver_paths[i]);
                if (pp) {
                    bldr.add_build("REDNODES", path.dirname(pp));
                }
            }
        }

        if (check_template(template, "build", "MCUROOT")){
            let rmp = path.resolve(__dirname, "./../node-red-mcu");
            manifest.add_build("MCUROOT", rmp);
        }

        fs.writeFileSync(mnfst_path, bldr.get(), (err) => {
            if (err) {
                throw err;
            }
        });

        let changed = false;

        let deps = template.include ?? [];
        for (let key of deps) {
            let mnfst = this.get_manifest_of_module(key, destination);
            if (mnfst && typeof (mnfst) === "string") {
                bldr.include_manifest(mnfst);
                changed = true;
                continue;
            }
            mnfst = this.create_manifests_for_module(key, destination);
            if (mnfst && typeof(mnfst) === "string") {
                bldr.include_manifest(mnfst);
                changed = true;
            }
        }

        if (changed === true) {
            fs.ensureDirSync(path.dirname(mnfst_path));
            fs.writeFileSync(mnfst_path, bldr.get(), (err) => {
                if (err) {
                    throw err;
                }
            });    
        }

        for (let file of template.copy ?? []) {
            let src = path.resolve(path.dirname(template_path), file);
            let to = path.resolve(path.dirname(mnfst_path), file);
            fs.copyFileSync(src, to)
        }

        return mnfst_path;

    }

    add_build(key, value) {
        if (!this.manifest.build) {
            this.manifest.build = {}
        }
        this.manifest.build[key] = value;
    }

    add_module(_path, key) {

        key = key ?? "*";
        if (typeof(key) !== "string") throw("typeof(key) must be string.")

        if (!this.manifest) {
            throw "Missing manifest @ add_module"
        }

        if (!this.manifest.modules) {
            this.manifest.modules = {
                "*": [],
                "~": []
            };
        }

        if (!this.manifest.modules[key]) {
            this.manifest.modules[key] = _path;
            return true;
        }

        let mms = this.manifest.modules[key];
        if (Array.isArray(mms)) {
            if (mms.indexOf(_path) < 0) {
                mms.push(_path);
                return true;
            }        
        } else if (_path !== mms) {
            this.manifest.modules[key] = [ mms, _path]
            return true;
        }

        return false;
    }

    add_preload(module) {
        if (!this.manifest.preload) {
            this.manifest.preload = []
        }
        if (this.manifest.preload.indexOf(module) < 0) {
            this.manifest.preload.push(module);
        }        
    }

    // create_manifests_from_package

    get() {
        return JSON.stringify(this.manifest, null, "  ");
    }

    add(object, key) {

        this.manifest[key] ??= {};

        let slot = this.manifest[key];
        let obj = clone(object);

        for (let k in obj) {
            slot[k] = obj[k];
        }

    }
}


module.exports = {
    builder: manifest_builder
}