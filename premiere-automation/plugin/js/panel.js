// ═══════════════════════════════════════════════════════════════════════
//  INFOGRAPHIC STUDIO — PANEL CONTROLLER
//
//  Clean UXP-native panel driving the 3-stage engine:
//    1. Select folder + load manifest
//    2. Validate → Import → Build
//    3. Results + log
//
//  Engine lives in host/engine.jsx — loaded once via $.evalFile().
//  All heavy lifting stays in ExtendScript. Panel is UI only.
// ═══════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  // ── State ──
  var folderPath = null;
  var manifest = null;
  var ingestResult = null;
  var engineLoaded = false;

  // ── DOM ──
  var $ = function (id) { return document.getElementById(id); };


  // ════════════════════════════════════════════════════
  //  SCRIPT BRIDGE
  //  Tries: UXP → CEP → error
  //  Auto-loads engine.jsx on first call
  // ════════════════════════════════════════════════════

  function evalHost(script) {
    return new Promise(function (resolve, reject) {
      // UXP
      if (typeof require !== "undefined") {
        try {
          var mod = require("premierepro");
          if (mod && mod.host && mod.host.evalScript) {
            return mod.host.evalScript(script).then(resolve, reject);
          }
        } catch (e) {}
        try {
          var uxp = require("uxp");
          if (uxp.host && uxp.host.evalScript) {
            return uxp.host.evalScript(script).then(resolve, reject);
          }
        } catch (e) {}
      }

      // CEP
      if (typeof CSInterface !== "undefined") {
        var cs = new CSInterface();
        cs.evalScript(script, function (r) {
          r === "EvalScript error." ? reject(new Error("ExtendScript error")) : resolve(r);
        });
        return;
      }

      reject(new Error("No host bridge — open this panel inside Premiere Pro"));
    });
  }

  function enginePath() {
    if (typeof CSInterface !== "undefined") {
      return new CSInterface().getSystemPath(SystemPath.EXTENSION) + "/host/engine.jsx";
    }
    // UXP: __dirname or relative
    if (typeof __dirname !== "undefined") {
      return __dirname + "/host/engine.jsx";
    }
    return "./host/engine.jsx";
  }

  function ensureEngine() {
    if (engineLoaded) return Promise.resolve();
    var path = enginePath().replace(/\\/g, "\\\\");
    return evalHost('$.evalFile("' + path + '")').then(
      function () { engineLoaded = true; log("Engine loaded"); },
      function () {
        // Maybe already loaded (user ran script manually)
        return evalHost("typeof validateManifest").then(function (r) {
          if (r === "function") { engineLoaded = true; log("Engine already in host"); return; }
          throw new Error("Cannot load engine.jsx");
        });
      }
    );
  }

  function runEngine(fn, args) {
    var argStr = (args || []).map(function (a) {
      if (typeof a === "string") return "'" + a.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
      return JSON.stringify(a);
    }).join(", ");

    return ensureEngine().then(function () {
      return evalHost(fn + "(" + argStr + ")");
    });
  }


  // ════════════════════════════════════════════════════
  //  UI HELPERS
  // ════════════════════════════════════════════════════

  function log(msg) {
    var el = $("log");
    var ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    el.textContent += "[" + ts + "] " + msg + "\n";
    el.scrollTop = el.scrollHeight;
  }

  function setStatus(text, type) {
    var el = $("status");
    el.textContent = text;
    el.className = "status-pill" + (type ? " " + type : "");
  }

  function show(id) { $(id).classList.remove("hidden"); }
  function hide(id) { $(id).classList.add("hidden"); }

  function enableBtn(id) { $(id).disabled = false; }
  function disableBtn(id) { $(id).disabled = true; }

  function renderItemList(details) {
    var list = $("itemList");
    list.innerHTML = "";

    var okCount = 0, warnCount = 0, failCount = 0;

    (details || []).forEach(function (d) {
      var li = document.createElement("li");
      var dot = document.createElement("span");
      dot.className = "dot";

      var status;
      if (d.error) {
        status = "fail"; failCount++;
      } else if (d.warning) {
        status = "warn"; warnCount++;
      } else if (d.verified || d.status === "placed") {
        status = "ok"; okCount++;
      } else {
        status = "skip";
      }
      dot.classList.add(status);

      var idSpan = document.createElement("span");
      idSpan.className = "id";
      idSpan.textContent = d.id || "";

      var msgSpan = document.createElement("span");
      msgSpan.className = "msg";
      msgSpan.textContent = d.error || d.warning || d.reason || (d.importedItemName || d.status || "ok");

      li.appendChild(dot);
      li.appendChild(idSpan);
      li.appendChild(msgSpan);
      list.appendChild(li);
    });

    $("r-ok").textContent = okCount;
    $("r-warn").textContent = warnCount;
    $("r-fail").textContent = failCount;

    show("resultsCard");
  }


  // ════════════════════════════════════════════════════
  //  FILE PICKER
  // ════════════════════════════════════════════════════

  function pickFolder() {
    return new Promise(function (resolve, reject) {
      // UXP
      if (typeof require !== "undefined") {
        try {
          var fs = require("uxp").storage.localFileSystem;
          return fs.getFolder().then(function (folder) {
            resolve(folder ? folder.nativePath : null);
          }, reject);
        } catch (e) {}
      }

      // CEP fallback: use ExtendScript Folder.selectDialog
      evalHost('Folder.selectDialog("Select export folder").fsName').then(resolve, reject);
    });
  }

  function loadManifestFromFolder(path) {
    return new Promise(function (resolve, reject) {
      // Try reading via ExtendScript (works in both UXP and CEP)
      var script =
        'var f = new File("' + path.replace(/\\/g, "\\\\") + '/manifest.json");' +
        'if (!f.exists) { "ERROR:not_found"; }' +
        'else { f.open("r"); var c = f.read(); f.close(); c; }';

      evalHost(script).then(function (result) {
        if (result === "ERROR:not_found") {
          reject(new Error("manifest.json not found in folder"));
          return;
        }
        resolve(JSON.parse(result));
      }, reject);
    });
  }


  // ════════════════════════════════════════════════════
  //  ACTIONS
  // ════════════════════════════════════════════════════

  // Select folder
  $("selectFolder").onclick = function () {
    pickFolder().then(function (path) {
      if (!path) return;
      folderPath = path;
      $("folderPath").textContent = path;
      log("Folder: " + path);
      enableBtn("loadManifest");
    }).catch(function (e) {
      log("Folder pick failed: " + e.message);
    });
  };

  // Load manifest
  $("loadManifest").onclick = function () {
    if (!folderPath) { log("Select folder first"); return; }
    setStatus("Loading...", "active");

    loadManifestFromFolder(folderPath).then(function (data) {
      manifest = data;

      // Update stats
      $("m-items").textContent = (manifest.items || []).length;
      $("m-fps").textContent = manifest.fps || 25;
      var res = manifest.resolution || {};
      $("m-res").textContent = (res.width || 1920) + "x" + (res.height || 1080);
      var trackCount = manifest.tracks ? Object.keys(manifest.tracks).length : 0;
      $("m-tracks").textContent = trackCount;
      show("manifestStats");

      $("manifestStatus").textContent = manifest.projectName || "Loaded";
      log("Manifest: " + (manifest.items || []).length + " items, " + (manifest.fps || 25) + "fps");

      enableBtn("validate");
      setStatus("Manifest loaded", "done");

    }).catch(function (e) {
      log("Manifest error: " + e.message);
      setStatus("Error", "error");
    });
  };

  // Validate
  $("validate").onclick = function () {
    if (!folderPath || !manifest) return;
    setStatus("Validating...", "active");
    log("Running validation...");

    // Write manifest to a temp file so engine can read it,
    // or pass the folder path and let engine find manifest.json
    runEngine("validateManifest", [folderPath + "/manifest.json"]).then(function (resultJSON) {
      var result = JSON.parse(resultJSON);

      if (result.errors && result.errors.length > 0) {
        result.errors.forEach(function (e) { log("ERR: " + e); });
      }
      if (result.warnings && result.warnings.length > 0) {
        result.warnings.forEach(function (w) { log("WARN: " + w); });
      }

      if (result.valid) {
        log("Validation passed");
        enableBtn("import");
        setStatus("Valid", "done");
      } else {
        log("Validation FAILED (" + result.errors.length + " errors)");
        setStatus(result.errors.length + " errors", "error");
      }
    }).catch(function (e) {
      log("Validate failed: " + e.message);
      setStatus("Error", "error");
    });
  };

  // Import
  $("import").onclick = function () {
    if (!folderPath) return;
    setStatus("Importing...", "active");
    disableBtn("import");
    log("Importing sequences...");

    runEngine("ingestMedia", [folderPath + "/manifest.json"]).then(function (resultJSON) {
      ingestResult = JSON.parse(resultJSON);

      log("Imported: " + ingestResult.imported + "/" + ingestResult.total);
      if (ingestResult.failed && ingestResult.failed.length > 0) {
        ingestResult.failed.forEach(function (f) {
          log("FAIL: " + f.id + " — " + f.reason);
        });
      }

      renderItemList(ingestResult.itemDetails || []);
      enableBtn("build");
      enableBtn("import"); // allow re-run

      if (ingestResult.failed && ingestResult.failed.length > 0) {
        setStatus(ingestResult.imported + " ok, " + ingestResult.failed.length + " failed", "error");
      } else {
        setStatus(ingestResult.imported + " imported", "done");
      }

    }).catch(function (e) {
      log("Import failed: " + e.message);
      setStatus("Import error", "error");
      enableBtn("import");
    });
  };

  // Build timeline
  $("build").onclick = function () {
    if (!ingestResult) { log("Import first"); return; }
    setStatus("Building...", "active");
    disableBtn("build");
    log("Building timeline...");

    runEngine("buildTimeline", [
      folderPath + "/manifest.json",
      JSON.stringify(ingestResult)
    ]).then(function (resultJSON) {
      var result = JSON.parse(resultJSON);

      log("Placed: " + result.placed + "  Failed: " + result.failed + "  Skipped: " + result.skipped);
      if (result.collisions) log("Collisions: " + result.collisions);

      // Show placement results
      renderItemList(result.report || []);
      enableBtn("build");

      if (result.failed > 0 || result.collisions > 0) {
        setStatus("Built with issues", "error");
      } else {
        setStatus("Timeline built", "done");
      }

    }).catch(function (e) {
      log("Build failed: " + e.message);
      setStatus("Build error", "error");
      enableBtn("build");
    });
  };

  // Clear log
  $("clearLog").onclick = function () {
    $("log").textContent = "";
  };


  // ════════════════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════════════════

  log("Infographic Studio panel ready");
  log("Select an export folder to begin");

})();
