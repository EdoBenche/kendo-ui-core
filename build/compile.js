#! /usr/bin/env node

var fs = require("fs");
var sys = require("util");
var u2 = require("uglify-js");
var path = require("path");
var OPT = require("optimist");
var ARGV = OPT
    .describe("amd", "Wrap for RequireJS")
    .describe("deps", "List dependencies")
    .describe("bundle", "Create a bundle")
    .describe("kendo-config", "Generate download-builder/kendo-config.json (to STDOUT)")
    .describe("overwrite", "Only for kendo-config, if specified the file will be overwritten")
    .describe("beautify", "Output indented code (helps debugging)")
    .describe("nomangle", "Don't mangle names (helps debugging)")
    .boolean("amd")
    .boolean("deps")
    .boolean("bundle")
    .boolean("kendo-config")
    .boolean("overwrite")
    .boolean("beautify")
    .boolean("nomangle")
    .wrap(80)
    .argv;

var KENDO_SRCDIR = path.join(path.dirname(fs.realpathSync(__filename)), "..");

var deps_file_name = path.join(KENDO_SRCDIR, "download-builder/config/kendo-config.json");
var template = JSON.parse(fs.readFileSync("download-builder/config/categories.json", "utf8"));

var files = ARGV._.slice();

if (ARGV.bundle) {
    var files = ARGV._.slice();
    var destination = files.shift();
    var destination_min = destination.replace(/\.js$/i, ".min.js");
    var toplevel = new u2.AST_Toplevel({ body: [] });
    var orig_data = [];
    files.forEach(function(file){
        orig_data.push(fs.readFileSync(file, "utf8"));
        var ast = compile_one_file(file, ast);
        toplevel.body = toplevel.body.concat(ast.body);
    });
    fs.writeFileSync(destination, orig_data.join("\n"));
    toplevel = squeeze(toplevel);
    if (!ARGV["nomangle"]) {
        toplevel.figure_out_scope();
        toplevel.compute_char_frequency();
        toplevel.mangle_names();
    }
    var codegen_options = {};
    if (ARGV["beautify"]) {
        codegen_options.beautify = true;
    }
    fs.writeFileSync(destination_min, toplevel.print_to_string(codegen_options));
    process.exit(0);
}

if (ARGV["kendo-config"]) {
    var js_dir = path.join(KENDO_SRCDIR, "src")
    , js_files = fs.readdirSync(js_dir)
        .filter(function(filename){
            // only source files
            return /^kendo\..*\.js$/i.test(filename) && !/\.min\.js$/i.test(filename);
        })
        .filter(function(filename){
            // discard bundles
            return !/^kendo\.(web|dataviz|mobile|all|winjs)\.js$/.test(filename);
        })
        .sort();
    var components = [];
    js_files.forEach(function(filename){
        var code = fs.readFileSync(path.join(js_dir, filename), "utf8");
        var ast = u2.parse(code, { filename: filename });
        ast = extract_deps(ast, filename);
        var c = ast.component;
        if (c) {
            c.source = filename.replace(/\.js$/i, ".min.js");
            c.widgets = extract_widget_info(ast);
            components.push(c);
        }
    });

    template.components = components;
    if (ARGV.overwrite) {
        fs.writeFileSync(deps_file_name, JSON.stringify(template, null, 4));
    } else {
        sys.puts(JSON.stringify(template, null, 4));
    }
    process.exit(0);
}

var get_wrapper = (function(wrapper){
    var code = '((typeof define == "function" && define.amd) ? define : function(deps, body){ return body() })($DEPS, $CONT)';
    return function() {
        if (wrapper) return wrapper;
        wrapper = u2.parse(code);
        wrapper.wrap = function(id, deps, cont) {
            return wrapper.transform(new u2.TreeTransformer(
                null,           // need no 'before'
                function after(node){
                    if (node instanceof u2.AST_SymbolRef) switch (node.name) {
                      case "$ID":
                        return new u2.AST_String({ value: id });
                      case "$DEPS":
                        return new u2.AST_Array({
                            elements: deps.map(function(x){
                                return new u2.AST_String({ value: x });
                            })
                        });
                      case "$CONT":
                        cont = cont.clone();
                        cont.argnames = [];
                        return new u2.AST_Function(cont);
                        break;
                    }
                }
            ));
        };
        return wrapper;
    };
})();

function compile_one_file(file) {
    var code = fs.readFileSync(file, "utf8");
    var ast = u2.parse(code, { filename: file });
    ast = extract_deps(ast, file);
    if (!ast.is_bundle) {
        var deps = ast.deps;
        var id = "kendo." + ast.component.id;
        if (ARGV.deps) {
            sys.puts(file + ": " + deps.join(", "));
            return;
        }
        deps = deps.map(function(dep){
            var dir = path.dirname(dep);
            dep = "kendo." + path.basename(dep) + ".min";
            return dir != "." ? path.join(dir, dep) : "./" + dep;
        });
        if (ARGV.amd) {
            ast = get_wrapper().wrap(id, deps, ast);
        }
    } else if (ARGV.deps) {
        sys.puts(file + " is a bundle");
        return;
    }
    return ast;
}

function squeeze(ast) {
    var compressor = u2.Compressor({
        warnings: false,
        hoist_vars: true,
    });
    ast.figure_out_scope();
    ast = ast.transform(compressor);
    return ast;
}

files.forEach(function (file){
    var output = file.replace(/\.js$/i, ".min.js");
    if (output == file)
        throw new Error("Won't overwrite " + file);
    var ast = compile_one_file(file);
    ast = squeeze(ast);
    if (!ARGV["nomangle"]) {
        ast.figure_out_scope();
        ast.compute_char_frequency();
        ast.mangle_names();
    }
    var codegen_options = {};
    if (ARGV["beautify"]) {
        codegen_options.beautify = true;
    }
    code = ast.print_to_string(codegen_options);
    fs.writeFileSync(output, code);
});

function extract_widget_info(ast) {
    ast.figure_out_scope();
    var widgets = [];
    var scope = null;

    // Quick-n-dirty heuristic that should cover the use cases in Kendo.
    function dumb_eval(node) {
        if (node instanceof u2.AST_Constant) {
            return node.getValue();
        }
        if (node instanceof u2.AST_SymbolRef) {
            var init = node.definition().init;
            if (init) {
                return dumb_eval(init);
            }
            return node.name;
        }
        if (node instanceof u2.AST_Dot) {
            return dumb_eval(node.expression) + "." + node.property;
        }
        if (node instanceof u2.AST_Call && is_widget(node)) {
            return "kendo.ui.Widget.extend";
        }
        return null;        // dunno how to handle
    }

    // determine if node points to [window.]kendo.ui.SOMETHING
    function is_widget(node) {
        if (node instanceof u2.AST_Call &&
            node.expression instanceof u2.AST_Dot &&
            node.expression.property == "extend") {
            var x = dumb_eval(node.expression);
            if (!x) return false;
            return /^(window\.)?(kendo|kendo\.dataviz|kendo\.mobile)\.ui\..+?\.extend/.test(x);
        }
    }

    var tw = new u2.TreeWalker(function(node, descend){
        if (node instanceof u2.AST_Scope) {
            var save_scope = scope;
            scope = node;
            descend();
            scope = save_scope;
            return true;
        }
        if (is_widget(node)) {
            var def = node.args[0];
            var options = def.properties.filter(function(prop){
                return prop.key == "options";
            })[0];
            if (options) {
                var name = options.value.properties.filter(function(prop){
                    return prop.key == "name";
                })[0];
                if (name && name.value) {
                    name = name.value.value;
                    widgets.push({
                        name     : name,
                        options  : options.value.properties.map(function(prop){ return prop.key }),
                        inherits : node.expression.expression.print_to_string({ beautify: true }),
                        file     : node.start.file,
                        line     : node.start.line,
                        col      : node.start.col
                    });
                }
            }
        }
    });
    ast.walk(tw);
    return widgets;
}

function extract_deps(ast, comp_filename) {
    // HACK: need to add "core" dependency to each culture file, so
    // that cultures can be loaded with RequireJS.  Rather than adding
    // it to the original sources, I think it's preferable that the
    // build script handles this as a special case.
    var m = /^src\/cultures\/kendo\.(.*)\.js$/.exec(comp_filename);
    if (m) {
        ast.deps = [ "../core" ];
        ast.component = {
            id: m[1]
        };
        return ast;
    }
    var component, is_bundle = false;
    var tt = new u2.TreeTransformer(function before(node, descend){
        if (node !== ast) {
            if (node instanceof u2.AST_Lambda) return node; // don't search subscopes
            if (node instanceof u2.AST_SimpleStatement &&
                node.body instanceof u2.AST_Call
                && node.body.expression instanceof u2.AST_SymbolRef
                && node.body.expression.name == "kendo_module")
            {
                if (component) is_bundle = true;
                component = node.body.args[0].print_to_string();
                component = (1, eval)("(" + component + ")");

                // discard kendo_module calls
                if (!component.files || component.files.length == 0)
                    return u2.MAP.skip;

                // however, if we have a split component, better load those files now.
                var block = new u2.AST_BlockStatement({ body: [] });
                component.files.forEach(function(file){
                    var full = path.join(path.dirname(comp_filename), file);
                    var code = fs.readFileSync(full, "utf8");
                    u2.parse(code, {
                        filename: file,
                        toplevel: block
                    });
                });
                return u2.MAP.splice(block.body);
            }
            if (node instanceof u2.AST_Var && node.definitions[0].name.name == "kendo_module") {
                // discard the kendo_module function
                return new u2.AST_EmptyStatement(node);
            }
            return node;
        }
    });
    ast = ast.transform(tt);
    ast.is_bundle = is_bundle;
    if (!component && !is_bundle) {
        ast.is_bundle = true;
        return ast;
    }
    if (!is_bundle) {
        var deps = component.depends ? component.depends.slice() : [];
        if (component.features) component.features.forEach(function(f){
            if (f.depends) deps = deps.concat(f.depends);
        });
        ast.deps = deps;
        ast.component = component;
    }
    return ast;
};
