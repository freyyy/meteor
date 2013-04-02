var path = require('path');
var _ = require('underscore');
var files = require('./files.js');
var warehouse = require('./warehouse.js');
var meteorNpm = require('./meteor_npm.js');
var fs = require('fs');

// Under the hood, packages in the library (/package/foo), and user
// applications, are both Packages -- they are just represented
// differently on disk.
//
// To create a package object from a package in the library:
//   var pkg = new Package;
//   pkg.init_from_library(name);
//
// To create a package object from an app directory:
//   var pkg = new Package;
//   pkg.initFromAppDir(app_dir, ignore_files, packageSearchOptions);

var next_package_id = 1;
var Package = function () {
  var self = this;

  // Fields set by init_*:
  // name: package name, or null for an app pseudo-package or collection
  // source_root: base directory for resolving source files, null for collection
  // serve_root: base directory for serving files, null for collection

  // A unique ID (guaranteed to not be reused in this process -- if
  // the package is reloaded, it will get a different id the second
  // time)
  self.id = next_package_id++;

  // package metadata, from describe()
  self.metadata = {};

  self.roleHandlers = {use: null, test: null};
  self.npmDependencies = null;

  // registered source file handlers
  self.extensions = {};

  // Packages used. Map from role to where to array of package name
  // (string.) The ordering in the array is significant only for
  // determining import symbol priority (it doesn't affect load
  // order.) A given package name should occur only once in a given
  // array.
  self.uses = {use: {client: [], server: []},
               test: {client: [], server: []}};

  // packages dependencies against which we are unordered (we don't
  // mind if they load after us, as long as they load.) map from
  // package name to true.
  self.unordered = {};

  // source files used. map from role to where to array of string path.
  self.sources = {use: {client: [], server: []},
                  test: {client: [], server: []}};

  // Other files that we want to monitor for changes in development
  // mode, such as package.js. Array of relative paths.
  self.extraDependencies = [];

  // All symbols exported from the JavaScript code in this
  // package. Map from role to where to array of string symbol (eg
  // "Foo", "Bar.baz".)
  //
  // XXX for now, when the package is loaded, this is just the
  // explicitly exported symbols from package.js, not @export
  // comments. The bundler's link pass then rewrites this to the
  // complete symbol list. This is a hack -- it should have the
  // complete list to start with.
  self.exports = {use: {client: [], server: []},
                  test: {client: [], server: []}};

  // functions that can be called when the package is scanned --
  // visible as `Package` when package.js is executed
  self.packageFacade = {
    // keys
    // - summary: for 'meteor list'
    // - internal: if true, hide in list
    // - environments: optional
    //   (1) if present, if depended on in an environment not on this
    //       list, then throw an error
    //   (2) if present, these are also the environments that will be
    //       used when an application uses the package (since it can't
    //       specify environments.) if not present, apps will use
    //       [''], which is suitable for a package that doesn't care
    //       where it's loaded (like livedata.)
    describe: function (metadata) {
      _.extend(self.metadata, metadata);
    },

    on_use: function (f) {
      if (self.roleHandlers.use)
        throw new Error("A package may have only one on_use handler");
      self.roleHandlers.use = f;
    },

    on_test: function (f) {
      if (self.roleHandlers.test)
        throw new Error("A package may have only one on_test handler");
      self.roleHandlers.test = f;
    },

    register_extension: function (extension, callback) {
      if (_.has(self.extensions, extension))
        throw new Error("This package has already registered a handler for " +
                        extension);
      self.extensions[extension] = callback;
    },

    // Same as node's default `require` but is relative to the
    // package's directory. Regular `require` doesn't work well
    // because we read the package.js file and `runInThisContext` it
    // separately as a string.  This means that paths are relative to
    // the top-level meteor.js script rather than the location of
    // package.js
    _require: function(filename) {
      return require(path.join(self.source_root, filename));
    }
  };

  // npm functions that can be called when the package is scanned --
  // visible `Npm` when package.js is executed
  self.npmFacade = {
    depends: function (npmDependencies) {
      if (self.npmDependencies)
        throw new Error("Can only call `Npm.depends` once in package " + self.name + ".");

      // don't allow npm fuzzy versions so that there is complete
      // consistency when deploying a meteor app
      //
      // XXX use something like seal or lockdown to have *complete* confidence
      // we're running the same code?
      meteorNpm.ensureOnlyExactVersions(npmDependencies);

      self.npmDependencies = npmDependencies;
    },

    require: function (name) {
      var nodeModuleDir = path.join(self.source_root, '.npm', 'node_modules', name);
      if (fs.existsSync(nodeModuleDir)) {
        return require(nodeModuleDir);
      } else {
        try {
          return require(name); // from the dev bundle
        } catch (e) {
          throw new Error("Can't find npm module '" + name + "'. Did you forget to call 'Npm.depends'?");
        }
      }
    }
  };

};

_.extend(Package.prototype, {
  // loads a package's package.js file into memory, using
  // runInThisContext. Wraps the contents of package.js in a closure,
  // supplying pseudo-globals 'Package' and 'Npm'.
  initFromPackageDir: function (name, dir) {
    var self = this;
    self.name = name;
    self.source_root = dir;
    self.serve_root = path.join(path.sep, 'packages', name);

    if (!fs.existsSync(self.source_root))
      throw new Error("The package named " + self.name + " does not exist.");

    // We use string concatenation to load package.js rather than
    // directly `require`ing it because that allows us to simplify the
    // package API (such as supporting Package.on_use rather than
    // something like Package.current().on_use)

    var fullpath = path.join(self.source_root, 'package.js');
    var code = fs.readFileSync(fullpath).toString();
    // \n is necessary in case final line is a //-comment
    var wrapped = "(function(Package,Npm){" + code + "\n})";
    // See #runInThisContext
    //
    // XXX it'd be nice to runInNewContext so that the package
    // setup code can't mess with our globals, but objects that
    // come out of runInNewContext have bizarro antimatter
    // prototype chains and break 'instanceof Array'. for now,
    // steer clear
    var func = require('vm').runInThisContext(wrapped, fullpath, true);
    func(self.packageFacade, self.npmFacade);

    self.extraDependencies.push('package.js');

    // For this old-style, on_use/on_test/where-based package, figure
    // out its dependencies by calling its on_xxx functions and seeing
    // what it does.
    //
    // We have a simple strategy. Call its on_xxx handler with no
    // 'where', which is what happens when the package is added
    // directly to an app, and see what files it adds to the client
    // and the server. Call the former the client version of the
    // package, and the latter the server version. Then, when a
    // package is used, include it in both the client and the server
    // by default. This simple strategy doesn't capture even 10% of
    // the complexity possible with on_use, on_test, and where, but
    // probably is sufficient for virtually all packages that actually
    // exist in the field, if not every single
    // one. #OldStylePackageSupport
    _.each(["use", "test"], function (role) {
      if (self.roleHandlers[role]) {
        self.roleHandlers[role]({
          // Called when this package wants to make another package be
          // used. Can also take literal package objects, if you have
          // anonymous packages you want to use (eg, app packages)
          //
          // options can include:
          //
          // - role: defaults to "use", but you could pass something
          //   like "test" if for some reason you wanted to include a
          //   package's tests
          //
          // - unordered: if true, don't require this package to load
          //   before us -- just require it to be loaded anytime. Also
          //   don't bring this package's imports into our
          //   namespace. If false, override a true value specified in
          //   a previous call to use for this package name. (A
          //   limitation of the current implementation is that this
          //   flag is not tracked per-environment or per-role.)  This
          //   option can be used to resolve circular dependencies in
          //   exceptional circumstances, eg, the 'meteor' package
          //   depends on 'handlebars', but all packages (including
          //   'handlebars') have an implicit dependency on
          //   'meteor'. Internal use only -- future support of this
          //   is not guaranteed. #UnorderedPackageReferences
          use: function (names, where, options) {
            options = options || {};

            if (!(names instanceof Array))
              names = names ? [names] : [];

            if (!(where instanceof Array))
              where = where ? [where] : ["client", "server"];

            _.each(names, function (name) {
              _.each(where, function (w) {
                if (options.role && options.role !== "use")
                  throw new Error("Role override is no longer supported");
                self.uses[role][w].push(name);
                if (options.unordered)
                  self.unordered[name] = true;
              });
            });
          },

          // Top-level call to add a source file to a package. It will
          // be processed according to its extension (eg, *.coffee
          // files will be compiled to JavaScript.)
          add_files: function (paths, where) {
            if (!(paths instanceof Array))
              paths = paths ? [paths] : [];

            if (!(where instanceof Array))
              where = where ? [where] : [];

            _.each(paths, function (path) {
              _.each(where, function (w) {
                self.sources[role][w].push(path);
              });
            });
          },

          // Force the export of a symbol from this package. An
          // alternative to using @export directives. Possibly helpful
          // when you don't want to modify the source code of a third
          // party library.
          //
          // @param symbols String (eg "Foo", "Foo.bar") or array of String
          // @param where 'client', 'server', or an array of those
          exportSymbol: function (symbols, where) {
            if (!(symbols instanceof Array))
              symbols = symbols ? [symbols] : [];

            if (!(where instanceof Array))
              where = where ? [where] : [];

            _.each(symbols, function (symbol) {
              _.each(where, function (w) {
                self.exports[role][w].push(symbol);
              });
            });
          },
          error: function () {
            throw new Error("api.error(), ironically, is no longer supported");
          },
          registered_extensions: function () {
            throw new Error("api.registered_extensions() is no longer supported");
          }
        });
      }
    });

    // Also, everything depends on the package 'meteor', which sets up
    // the basic environment) (except 'meteor' itself)
    _.each(["use", "test"], function (role) {
      _.each(["client", "server"], function (where) {
        if (! (name === "meteor" && role === "use"))
          self.uses[role][where].unshift("meteor");
      });
    });

    self._uniquifyPackages();
  },

  // If a package appears twice in a 'self.uses' list, keep only the
  // rightmost instance.
  _uniquifyPackages: function () {
    var self = this;

    _.each(["use", "test"], function (role) {
      _.each(["client", "server"], function (where) {
        var input = self.uses[role][where];
        var output = [];

        var seen = {};
        for (var i = input.length - 1; i >= 0; i--) {
          if (! seen[input[i]])
            output.unshift(input[i]);
          seen[input[i]] = true;
        }

        self.uses[role][where] = output;
      });
    });
  },

  // @returns {Boolean} was the package found in the app's packages/
  // directory?
  initFromAppPackages: function (name, appDir) {
    var packageDirInApp = path.join(appDir, 'packages', name);
    if (files.is_package_dir(packageDirInApp)) {
      this.initFromPackageDir(name, packageDirInApp);
      return true;
    } else {
      return false;
    }
  },

  // Searches:
  // - $PACKAGE_DIRS (colon-separated)
  // - $METEOR/packages
  // @returns {Boolean} was the package found in any local package sets?
  initFromLocalPackages: function (name) {
    var packageDir = packages.directoryForLocalPackage(name);
    if (packageDir) {
      this.initFromPackageDir(name, packageDir);
      return true;
    } else {
      return false;
    }
  },

  initFromWarehouse: function (name, version) {
    this.initFromPackageDir(
      name,
      path.join(warehouse.getWarehouseDir(), 'packages', name, version));
  },

  initFromAppDir: function (app_dir, ignore_files, packageSearchOptions) {
    var self = this;
    self.name = null;
    self.source_root = app_dir;
    self.serve_root = path.sep;

    var sources_except = function (role, where, except, tests) {
      var allSources = self._scan_for_sources(role, where, ignore_files || [],
                                              packageSearchOptions);
      var withoutAppPackages = _.reject(allSources, function (sourcePath) {
        // Skip files that are in app packages. (Directories named "packages"
        // lower in the tree are OK.)
        return sourcePath.match(/^packages\//);
      });
      var withoutExceptDir = _.reject(withoutAppPackages, function (source_path) {
        return (path.sep + source_path + path.sep).indexOf(path.sep + except + path.sep) !== -1;
      });
      return _.filter(withoutExceptDir, function (source_path) {
        var is_test = ((path.sep + source_path + path.sep).indexOf(path.sep + 'tests' + path.sep) !== -1);
        return is_test === (!!tests);
      });
    };

    // standard client packages (for now), for the classic meteor
    // stack.
    // XXX remove and make everyone explicitly declare all dependencies
    var packages = ['meteor', 'deps', 'session', 'livedata', 'mongo-livedata',
                    'spark', 'templating', 'startup', 'past'];
    packages =
      _.union(packages,
              require(path.join(__dirname, 'project.js')).
              get_packages(app_dir));

    _.each(["use", "test"], function (role) {
      _.each(["client", "server"], function (where) {
        // Note that technically to match the historical behavior, we
        // should include a dependency of the 'test' role of the
        // package on the 'use' role. But we don't have a way to do
        // that, since these are strings and this package is
        // anonymous. But this shouldn't matter since this form of app
        // testing never actually shipped.
        self.uses[role][where] = packages;
      });
    });
    self._uniquifyPackages();

    self.sources.use.client = sources_except("use", "client", "server");
    self.sources.use.server = sources_except("use", "server", "client");
    self.sources.test.client =
      sources_except("test", "client", "server", true);
    self.sources.test.server =
      sources_except("test", "server", "client", true);

    // Old style
    // XXX remove
    self.packageFacade.on_use(function (api) {
      api.use(packages);
      api.add_files(self.sources.use.client, "client");
      api.add_files(self.sources.use.server, "server");
    });

    self.packageFacade.on_test(function (api) {
      api.use(packages);
      api.use(self);
      api.add_files(self.sources.test.client, "client");
      api.add_files(self.sources.test.server, "server");
    });
  },

  // Find all files under this.source_root that have an extension we
  // recognize, and return them as a list of paths relative to
  // source_root. Ignore files that match a regexp in the ignore_files
  // array, if given. As a special case (ugh), push all html files to
  // the head of the list.
  //
  // role should be 'use' or 'test'
  // where should be 'client' or 'server'
  _scan_for_sources: function (role, where, ignore_files,
                               packageSearchOptions) {
    var self = this;

    // find everything in tree, sorted depth-first alphabetically.
    var file_list =
      files.file_list_sync(self.source_root,
                           self.registeredExtensions(role, where,
                                                     packageSearchOptions));
    file_list = _.reject(file_list, function (file) {
      return _.any(ignore_files || [], function (pattern) {
        return file.match(pattern);
      });
    });
    file_list.sort(files.sort);

    // XXX HUGE HACK --
    // push html (template) files ahead of everything else. this is
    // important because the user wants to be able to say
    // Template.foo.events = { ... }
    //
    // maybe all of the templates should go in one file? packages
    // should probably have a way to request this treatment (load
    // order depedency tags?) .. who knows.
    var htmls = [];
    _.each(file_list, function (filename) {
      if (path.extname(filename) === '.html') {
        htmls.push(filename);
        file_list = _.reject(file_list, function (f) { return f === filename;});
      }
    });
    file_list = htmls.concat(file_list);

    // now make everything relative to source_root
    var prefix = self.source_root;
    if (prefix[prefix.length - 1] !== path.sep)
      prefix += path.sep;

    return file_list.map(function (abs) {
      if (path.relative(prefix, abs).match(/\.\./))
        // XXX audit to make sure it works in all possible symlink
        // scenarios
        throw new Error("internal error: source file outside of parent?");
      return abs.substr(prefix.length);
    });
  },

  // Called when this package wants to ensure certain npm dependencies
  // are installed for use within server code.
  //
  // @param npmDependencies {Object} eg {gcd: "0.0.0", tar: "0.1.14"}
  installNpmDependencies: function(quiet) {
    if (this.npmDependencies) {
      // go through a specialized npm dependencies update process, ensuring
      // we don't get new versions of any (sub)dependencies. this process
      // also runs safely multiple times in parallel (which could happen if you
      // have two apps running locally using the same package)
      meteorNpm.updateDependencies(this.name, this.npmDir(), this.npmDependencies, quiet);
    }
  },

  npmDir: function () {
    return path.join(this.source_root, '.npm');
  },

  // Return a list of all of the extension that indicate source files
  // inside this package, INCLUDING leading dots. Computed based on
  // this.uses, so should only be called once that has been set.
  //
  // 'role' should be 'use' or 'test'. 'where' should be 'client' or 'server'.
  registeredExtensions: function (role, where, packageSearchOptions) {
    var self = this;
    var ret = _.keys(self.extensions);

    _.each(self.uses[role][where], function (pkgName) {
      var pkg = packages.get(pkgName, packageSearchOptions);
      ret = _.union(ret, _.keys(pkg.extensions));
    });

    return _.map(ret, function (x) {return "." + x;});
  },

  // Find the function that should be used to handle a source file
  // found in this package. We'll use handlers that are defined in
  // this package and in its immediate dependencies. ('extension'
  // should be the extension of the file without a leading dot.)
  getSourceHandler: function (role, where, extension, packageSearchOptions) {
    var self = this;
    var candidates = [];

    if (role === "use" && extension in self.extensions)
      candidates.push(self.extensions[extension]);

    var seen = {};
    _.each(self.uses[role][where], function (pkgName) {
      var otherPkg = packages.get(pkgName, packageSearchOptions);
      if (extension in otherPkg.extensions)
        candidates.push(otherPkg.extensions[extension]);
    });

    // XXX do something more graceful than printing a stack trace and
    // exiting!! we have higher standards than that!

    if (!candidates.length)
      return null;

    if (candidates.length > 1)
      // XXX improve error message (eg, name the packages involved)
      // and make it clear that it's not a global conflict, but just
      // among this package's dependencies
      throw new Error("Conflict: two packages are both trying " +
                      "to handle ." + extension);

    return candidates[0];
  }
});

var loadedPackages = {};

var packages = module.exports = {

  // get a package by name. also maps package objects to themselves.
  // load order is:
  // - APP_DIR/packages (if options.appDir passed)
  // - PACKAGE_DIRS
  // - METEOR_DIR/packages (if in a git checkout)
  // - warehouse (if options.releaseManifest passed)
  get: function (name, options) {
    var self = this;
    options = options || {};
    if (name instanceof Package)
      return name;
    if (!(name in loadedPackages)) {
      var pkg = new Package;
      if (options.appDir && pkg.initFromAppPackages(name, options.appDir)) {
        loadedPackages[name] = pkg;
      } else if (pkg.initFromLocalPackages(name)) {
        loadedPackages[name] = pkg;
      } else if (options.releaseManifest) {
        pkg.initFromWarehouse(name, options.releaseManifest.packages[name]);
        loadedPackages[name] = pkg;
      }

      // XXX HACK: Ensure that all of our dependencies have been *read
      // from disk into Package objects* before we try to to call any
      // handlers. We need this because of the gross way that
      // templating works. 'handlebars' calls
      // Package._require("parse.js") at package.js load time which
      // splats the Handlebars symbol into the global namespace which
      // 'templating's extension handlers then depend on. One day (one
      // day soon I hope) we will model extensions as application code
      // rather than package.js code, and then we will be able to
      // represent its dependencies properly.
      _.each(["use", "test"], function (role) {
        _.each(["client", "server"], function (where) {
          _.each(pkg.uses[role][where], function (pkgName) {
            // force dependents to parse their package.js's
            self.get(pkgName, options);
          });
        });
      });
    }

    return loadedPackages[name];
  },

  // load a package directly from a directory. don't cache.
  loadFromDir: function(name, packageDir) {
    var pkg = new Package;
    pkg.initFromPackageDir(name, packageDir);
    return pkg;
  },

  // get a package that represents an app. (ignore_files is optional
  // and if given, it should be an array of regexps for filenames to
  // ignore when scanning for source files.)
  get_for_app: function (app_dir, ignore_files, packageSearchOptions) {
    var pkg = new Package;
    pkg.initFromAppDir(app_dir, ignore_files || [], packageSearchOptions);
    return pkg;
  },

  // force reload of all packages
  flush: function () {
    loadedPackages = {};
  },

  // get all packages available. searches:
  // - local package sets
  // - warehouse (if we are passed a release manifest)
  //
  // returns {Object} maps name to Package
  list: function (releaseManifest) {
    var self = this;
    var list = {};

    _.each(self._localPackageDirs(), function (dir) {
      _.each(fs.readdirSync(dir), function (name) {
        if (files.is_package_dir(path.join(dir, name))) {
          if (!list[name]) // earlier directories get precedent
            list[name] = packages.get(name); // empty release manifest, we're loading from local packages
        }
      });
    });

    if (releaseManifest) {
      _.each(releaseManifest.packages, function(version, name) {
        // don't even look for packages if they've already been
        // overridden (though this `if` isn't necessary for
        // correctness, since `packages.get` looks for packages in the
        // override directories first anyways)
        if (!list[name])
          list[name] = packages.get(name, {releaseManifest: releaseManifest});
      });
    }

    return list;
  },

  // returns a pretty list suitable for showing to the user. input is
  // a list of package objects, each of which must have a name (not be
  // an application package.)
  format_list: function (pkgs) {
    var longest = '';
    _.each(pkgs, function (pkg) {
      if (pkg.name.length > longest.length)
        longest = pkg.name;
    });
    var pad = longest.replace(/./g, ' ');
    // it'd be nice to read the actual terminal width, but I tried
    // several methods and none of them work (COLUMNS isn't set in
    // node's environment; `tput cols` returns a constant 80.) maybe
    // node is doing something weird with ptys.
    var width = 80;

    var out = '';
    _.each(pkgs, function (pkg) {
      if (pkg.metadata.internal)
        return;
      var name = pkg.name + pad.substr(pkg.name.length);
      var summary = pkg.metadata.summary || 'No description';
      out += (name + "  " +
              summary.substr(0, width - 2 - pad.length) + "\n");
    });

    return out;
  },

  // for a packge that exists in localPackageDirs, find the directory
  // in which it exists
  directoryForLocalPackage: function(name) {
    var ret;
    _.find(this._localPackageDirs(), function(packageDir) {
      var dir = path.join(packageDir, name);
      if (fs.existsSync(path.join(dir, 'package.js'))) {
        ret = dir;
        return true;
      }
      return false; // make lint happy
    });

    return ret;
  },

  _localPackageDirs: function () {
    var packageDirs = [];
    if (!files.usesWarehouse())
      packageDirs.push(path.join(files.getCurrentEngineDir(), 'packages'));

    if (process.env.PACKAGE_DIRS)
      packageDirs = process.env.PACKAGE_DIRS.split(':').concat(packageDirs);
    return packageDirs;
  }
};