// ═══════════════════════════════════════════════════════════════════════
//  INFOGRAPHIC STUDIO — UXP PANEL CONTROLLER
//
//  Wired to host/engine.jsx via evalScript bridge.
//
//  Flow:
//    1. Select export folder (contains PNG sequence folders + manifest.json)
//    2. Engine loads automatically on first call
//    3. Validate → Import → Build (each stage independent)
//    4. Results panel shows per-item status
//    5. Retry failed items without re-running everything
//
//  UXP: require("premierepro") for evalScript
//  CEP fallback: CSInterface.evalScript
// ═══════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  // ═══════════════════════════════════════
  //  STATE
  // ═══════════════════════════════════════

  var state = {
    folderPath: null,
    manifestPath: null,
    manifest: null,
    ingestResult: null,
    timelineResult: null,
    engineReady: false
  };

  var $ = function (id) { return document.getElementById(id); };


  // ═══════════════════════════════════════
  //  HOST BRIDGE — evalScript wrapper
  //
  //  UXP for Premiere Pro exposes ExtendScript
  //  evaluation through different module paths
  //  depending on the version. We try all known
  //  paths, then fall back to CEP.
  // ═══════════════════════════════════════

  var _evalFn = null; // Cached eval function

  function detectBridge() {
    if (_evalFn) return true;

    // UXP: premierepro module (Premiere Pro 25.x+)
    if (typeof require !== "undefined") {
      try {
        var ppro = require("premierepro");
        if (ppro && ppro.host && typeof ppro.host.evalScript === "function") {
          _evalFn = function (s) { return ppro.host.evalScript(s); };
          log("Bridge: UXP (premierepro.host.evalScript)");
          return true;
        }
      } catch (e) {}

      // UXP alternate: uxp.host module
      try {
        var uxp = require("uxp");
        if (uxp && uxp.host && typeof uxp.host.evalScript === "function") {
          _evalFn = function (s) { return uxp.host.evalScript(s); };
          log("Bridge: UXP (uxp.host.evalScript)");
          return true;
        }
      } catch (e) {}

      // UXP alternate: script module
      try {
        var scriptMod = require("uxp").script;
        if (scriptMod && typeof scriptMod.evalScript === "function") {
          _evalFn = function (s) { return scriptMod.evalScript(s); };
          log("Bridge: UXP (uxp.script.evalScript)");
          return true;
        }
      } catch (e) {}
    }

    // CEP fallback
    if (typeof CSInterface !== "undefined") {
      var cs = new CSInterface();
      _evalFn = function (s) {
        return new Promise(function (resolve, reject) {
          cs.evalScript(s, function (r) {
            if (r === "EvalScript error.") reject(new Error("ExtendScript error"));
            else resolve(r);
          });
        });
      };
      log("Bridge: CEP (CSInterface)");
      return true;
    }

    return false;
  }

  function evalHost(script) {
    if (!_evalFn && !detectBridge()) {
      return Promise.reject(new Error("No host bridge — run this panel inside Premiere Pro"));
    }
    try {
      var result = _evalFn(script);
      // Normalise: some bridges return raw values, some return Promises
      if (result && typeof result.then === "function") return result;
      return Promise.resolve(result);
    } catch (e) {
      return Promise.reject(e);
    }
  }


  // ═══════════════════════════════════════
  //  ENGINE LOADER
  //
  //  Loads host/engine.jsx into the Premiere
  //  ExtendScript context exactly once.
  //  Safe to call repeatedly (no-ops after load).
  // ═══════════════════════════════════════

  function resolveEnginePath() {
    // CEP: use system path
    if (typeof CSInterface !== "undefined") {
      try {
        return new CSInterface().getSystemPath(SystemPath.EXTENSION) + "/host/engine.jsx";
      } catch (e) {}
    }
    // UXP: __dirname available in plugin context
    if (typeof __dirname !== "undefined") {
      return __dirname + "/host/engine.jsx";
    }
    // UXP: plugin folder from entrypoints
    if (typeof require !== "undefined") {
      try {
        var folder = require("uxp").entrypoints.getPlugin().pluginFolder;
        if (folder) return folder.nativePath + "/host/engine.jsx";
      } catch (e) {}
    }
    return "./host/engine.jsx";
  }

  function loadEngine() {
    if (state.engineReady) return Promise.resolve();

    var path = resolveEnginePath().replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    log("Loading engine: " + path);

    return evalHost("$.evalFile('" + path + "')").then(
      function () {
        state.engineReady = true;
        log("Engine loaded OK");
      },
      function (err) {
        log("evalFile failed: " + (err.message || err));
        // Check if engine was already loaded (user ran script manually)
        return evalHost("typeof validateManifest === 'function'").then(function (r) {
          if (r === "true" || r === true) {
            state.engineReady = true;
            log("Engine already present in host");
            return;
          }
          throw new Error("Cannot load engine — copy host/engine.jsx next to the panel or run it manually via File > Scripts");
        });
      }
    );
  }

  /**
   * Call a named function in engine.jsx.
   * Auto-loads engine on first call.
   * String args are escaped and quoted. Objects are JSON-stringified.
   */
  function callEngine(fnName, args) {
    var parts = (args || []).map(function (a) {
      if (typeof a === "string") {
        return "'" + a.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
      }
      return JSON.stringify(a);
    });
    var script = fnName + "(" + parts.join(", ") + ")";

    var run = function () { return evalHost(script); };

    if (!state.engineReady) {
      return loadEngine().then(run);
    }
    return run();
  }


  // ═══════════════════════════════════════
  //  UI HELPERS
  // ═══════════════════════════════════════

  function log(msg) {
    var el = $("log");
    if (!el) return;
    var ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    el.textContent += "[" + ts + "] " + msg + "\n";
    el.scrollTop = el.scrollHeight;
  }

  function setStatus(text, type) {
    var el = $("status");
    el.textContent = text;
    el.className = "status-pill" + (type ? " " + type : "");
  }

  function show(id) { var el = $(id); if (el) el.classList.remove("hidden"); }
  function hide(id) { var el = $(id); if (el) el.classList.add("hidden"); }
  function enable(id) { var el = $(id); if (el) el.disabled = false; }
  function disable(id) { var el = $(id); if (el) el.disabled = true; }

  function renderResults(details) {
    var list = $("itemList");
    if (!list) return;
    list.innerHTML = "";

    var ok = 0, warn = 0, fail = 0;

    (details || []).forEach(function (d) {
      var li = document.createElement("li");

      // Status dot
      var dot = document.createElement("span");
      dot.className = "dot";
      var s;
      if (d.error || d.status === "failed" || d.status === "collision") {
        s = "fail"; fail++;
      } else if (d.warning || d.status === "skipped") {
        s = "warn"; warn++;
      } else if (d.verified || d.status === "placed") {
        s = "ok"; ok++;
      } else {
        s = "skip"; warn++;
      }
      dot.classList.add(s);

      // ID
      var idEl = document.createElement("span");
      idEl.className = "id";
      idEl.textContent = d.id || "";

      // Message
      var msg = document.createElement("span");
      msg.className = "msg";
      msg.textContent = d.error || d.warning || d.reason
        || (d.importedItemName ? d.importedItemName : "")
        || d.status || "ok";

      li.appendChild(dot);
      li.appendChild(idEl);
      li.appendChild(msg);
      list.appendChild(li);
    });

    $("r-ok").textContent = ok;
    $("r-warn").textContent = warn;
    $("r-fail").textContent = fail;
    show("resultsCard");

    return { ok: ok, warn: warn, fail: fail };
  }


  // ═══════════════════════════════════════
  //  FOLDER + MANIFEST PICKER
  // ═══════════════════════════════════════

  function pickFolder() {
    // UXP native folder picker
    if (typeof require !== "undefined") {
      try {
        var lfs = require("uxp").storage.localFileSystem;
        return lfs.getFolder().then(function (f) {
          return f ? f.nativePath : null;
        });
      } catch (e) {}
    }
    // CEP fallback: ExtendScript dialog
    return evalHost(
      'var _f = Folder.selectDialog("Select Premiere export folder");' +
      '_f ? _f.fsName : "";'
    ).then(function (r) { return r || null; });
  }

  function readManifest(folderPath) {
    var escapedPath = folderPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    var script =
      "var _mf = new File('" + escapedPath + "/manifest.json');" +
      "if (!_mf.exists) 'ERROR:NOT_FOUND';" +
      "else { _mf.open('r'); var _c = _mf.read(); _mf.close(); _c; }";
    return evalHost(script).then(function (raw) {
      if (raw === "ERROR:NOT_FOUND") throw new Error("manifest.json not found in " + folderPath);
      return JSON.parse(raw);
    });
  }


  // ═══════════════════════════════════════
  //  ACTIONS — wired to buttons
  // ═══════════════════════════════════════

  // ── 1. Select folder ──
  $("selectFolder").addEventListener("click", function () {
    setStatus("Picking...", "active");
    pickFolder().then(function (path) {
      if (!path) { setStatus("Cancelled", ""); return; }
      state.folderPath = path;
      state.manifestPath = path + "/manifest.json";
      $("folderPath").textContent = path;
      log("Folder: " + path);

      // Auto-load manifest
      setStatus("Loading manifest...", "active");
      return readManifest(path).then(function (data) {
        state.manifest = data;

        $("m-items").textContent = (data.items || []).length;
        $("m-fps").textContent = data.fps || 25;
        var r = data.resolution || {};
        $("m-res").textContent = (r.width || 1920) + "x" + (r.height || 1080);
        $("m-tracks").textContent = data.tracks ? Object.keys(data.tracks).length : 0;
        show("manifestStats");
        $("manifestStatus").textContent = data.projectName || "Loaded";

        log("Manifest: " + (data.items || []).length + " items @ " + (data.fps || 25) + "fps");
        enable("validate");
        setStatus("Ready", "done");
      });
    }).catch(function (e) {
      log("Error: " + e.message);
      setStatus("Error", "error");
    });
  });

  // ── 2. Validate ──
  $("validate").addEventListener("click", function () {
    if (!state.manifestPath) { log("Select folder first"); return; }
    setStatus("Validating...", "active");
    disable("validate");
    log("Validating...");

    callEngine("validateManifest", [state.manifestPath]).then(function (json) {
      var result = JSON.parse(json);

      if (result.errors) result.errors.forEach(function (e) { log("ERR: " + e); });
      if (result.warnings) result.warnings.forEach(function (w) { log("WARN: " + w); });

      var s = result.summary || {};
      log("Valid items: " + (s.validItems || 0) + "/" + (s.totalItems || 0));
      log("Tracks: " + (s.tracksUsed || []).join(", "));

      enable("validate");

      if (result.valid) {
        log("Validation PASSED");
        enable("import");
        setStatus("Valid", "done");
      } else {
        log("Validation FAILED — " + result.errors.length + " error(s)");
        setStatus(result.errors.length + " errors", "error");
      }
    }).catch(function (e) {
      log("Validate error: " + e.message);
      setStatus("Error", "error");
      enable("validate");
    });
  });

  // ── 3. Import ──
  $("import").addEventListener("click", function () {
    if (!state.manifestPath) return;
    setStatus("Importing...", "active");
    disable("import");
    log("Importing PNG sequences...");

    callEngine("ingestMedia", [state.manifestPath]).then(function (json) {
      state.ingestResult = JSON.parse(json);
      var r = state.ingestResult;

      log("Imported: " + r.imported + "/" + r.total);
      if (r.failed && r.failed.length > 0) {
        r.failed.forEach(function (f) { log("FAIL: " + f.id + " — " + f.reason); });
      }

      renderResults(r.itemDetails || []);
      enable("import");
      enable("build");

      // Enable retry if there are failures
      if (r.failed && r.failed.length > 0) {
        enable("retry");
        setStatus(r.imported + " ok, " + r.failed.length + " failed", "error");
      } else {
        disable("retry");
        setStatus(r.imported + " imported", "done");
      }
    }).catch(function (e) {
      log("Import error: " + e.message);
      setStatus("Import error", "error");
      enable("import");
    });
  });

  // ── 3b. Retry failed ──
  $("retry").addEventListener("click", function () {
    if (!state.ingestResult || !state.ingestResult.failed || state.ingestResult.failed.length === 0) {
      log("Nothing to retry");
      return;
    }
    log("Retrying " + state.ingestResult.failed.length + " failed item(s)...");
    setStatus("Retrying...", "active");
    disable("retry");

    // Re-run full ingest — the engine skips items already in the bin
    callEngine("ingestMedia", [state.manifestPath]).then(function (json) {
      state.ingestResult = JSON.parse(json);
      var r = state.ingestResult;

      log("Retry result: " + r.imported + "/" + r.total);
      renderResults(r.itemDetails || []);
      enable("retry");

      if (r.failed && r.failed.length > 0) {
        setStatus("Still " + r.failed.length + " failed", "error");
      } else {
        disable("retry");
        setStatus("All imported", "done");
      }
    }).catch(function (e) {
      log("Retry error: " + e.message);
      enable("retry");
    });
  });

  // ── 4. Build timeline ──
  $("build").addEventListener("click", function () {
    if (!state.ingestResult) { log("Import first"); return; }
    setStatus("Building timeline...", "active");
    disable("build");
    log("Placing clips on timeline...");

    callEngine("buildTimeline", [
      state.manifestPath,
      JSON.stringify(state.ingestResult)
    ]).then(function (json) {
      state.timelineResult = JSON.parse(json);
      var r = state.timelineResult;

      log("Placed: " + r.placed + "  Failed: " + r.failed + "  Skipped: " + r.skipped);
      if (r.collisions) log("Collisions: " + r.collisions);

      renderResults(r.report || []);
      enable("build");

      if (r.failed > 0 || r.collisions > 0) {
        setStatus("Built with " + (r.failed + (r.collisions || 0)) + " issue(s)", "error");
      } else {
        setStatus("Timeline built — " + r.placed + " clips", "done");
      }
    }).catch(function (e) {
      log("Build error: " + e.message);
      setStatus("Build error", "error");
      enable("build");
    });
  });

  // ── Clear log ──
  $("clearLog").addEventListener("click", function () { $("log").textContent = ""; });


  // ═══════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════

  log("Infographic Studio v1.0");
  log("Select an export folder to begin");

  // Pre-detect bridge on load
  if (detectBridge()) {
    log("Host bridge detected — loading engine...");
    loadEngine().catch(function (e) {
      log("Engine not pre-loaded: " + e.message);
      log("Will retry when you run a command");
    });
  } else {
    log("No host bridge yet — will detect on first action");
  }

})();
