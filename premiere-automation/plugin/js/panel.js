// ═══════════════════════════════════════════════════════════════════════
//  INFOGRAPHIC STUDIO — UXP PANEL CONTROLLER
//  panel.js
//
//  Drives the 4-step workflow:
//    1. Load manifest
//    2. Validate (Stage A)
//    3. Import media (Stage B)
//    4. Build timeline (Stage C)
//
//  Communicates with engine.jsx via the UXP script bridge.
//  Falls back to direct ExtendScript eval if UXP bridge unavailable.
// ═══════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  // ── State ──
  var state = {
    manifestPath: null,
    validationResult: null,
    ingestResult: null,
    timelineResult: null,
    currentStep: 1
  };

  // ── DOM refs ──
  var $ = function (id) { return document.getElementById(id); };

  // ── Script bridge ──
  // UXP for Premiere: use the premierepro scripting module
  // This abstracts the host communication so we can swap implementations

  var scriptBridge = {
    _engineLoaded: false,
    _bridge: null,  // "uxp" | "cep" | null

    /**
     * Resolve the path to engine.jsx relative to the plugin folder.
     * Works for both UXP and CEP layouts.
     */
    _enginePath: function () {
      // UXP: plugin folder from manifest
      if (typeof require !== "undefined") {
        try {
          var path = require("path");
          var uxpPlugin = require("uxp").entrypoints;
          // __dirname equivalent in UXP
          return path.join(__dirname, "host", "engine.jsx");
        } catch (e) {}
      }
      // CEP: resolve from extension root
      if (typeof CSInterface !== "undefined") {
        var cs = new CSInterface();
        return cs.getSystemPath(SystemPath.EXTENSION) + "/host/engine.jsx";
      }
      // Fallback: assume standard plugin layout
      return "./host/engine.jsx";
    },

    /**
     * Load engine.jsx into the Premiere host.
     * Must be called once before any run() calls.
     * Safe to call multiple times (no-ops after first load).
     */
    loadEngine: function () {
      if (this._engineLoaded) {
        return Promise.resolve(true);
      }

      var self = this;
      var enginePath = this._enginePath();

      // The key call: $.evalFile() loads the JSX into the host's
      // ExtendScript engine, making all functions available.
      return this.eval('$.evalFile("' + enginePath.replace(/\\/g, "\\\\") + '")').then(
        function () {
          self._engineLoaded = true;
          console.log("[panel] Engine loaded from: " + enginePath);
          return true;
        },
        function (err) {
          console.error("[panel] Failed to load engine: " + err);
          // Try without path (engine may already be loaded or user ran it manually)
          return self.eval("typeof validateManifest").then(function (result) {
            if (result === "function") {
              self._engineLoaded = true;
              console.log("[panel] Engine already loaded in host");
              return true;
            }
            throw new Error("Engine not available: " + err.message);
          });
        }
      );
    },

    /**
     * Evaluate an ExtendScript expression in the Premiere host.
     * Returns a Promise that resolves with the string result.
     */
    eval: function (script) {
      return new Promise(function (resolve, reject) {
        try {
          // UXP approach
          if (typeof require !== "undefined") {
            try {
              var ppro = require("premierepro");
              if (ppro && ppro.host && ppro.host.evalScript) {
                ppro.host.evalScript(script).then(resolve).catch(reject);
                return;
              }
            } catch (e) {}

            // UXP alternate: script module
            try {
              var uxp = require("uxp");
              if (uxp.host && uxp.host.evalScript) {
                uxp.host.evalScript(script).then(resolve).catch(reject);
                return;
              }
            } catch (e) {}
          }

          // CEP fallback
          if (typeof CSInterface !== "undefined") {
            var csInterface = new CSInterface();
            csInterface.evalScript(script, function (result) {
              if (result === "EvalScript error.") {
                reject(new Error("ExtendScript eval error"));
              } else {
                resolve(result);
              }
            });
            return;
          }

          reject(new Error("No script bridge available — open this panel inside Premiere Pro"));
        } catch (e) {
          reject(e);
        }
      });
    },

    /**
     * Run a named function from engine.jsx with arguments.
     * Automatically loads the engine if not yet loaded.
     * Serialises arguments as JSON strings.
     */
    run: function (fnName, args) {
      var self = this;
      var argStr = (args || []).map(function (a) {
        if (typeof a === "string") return "'" + a.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
        return JSON.stringify(a);
      }).join(", ");

      var script = fnName + "(" + argStr + ")";

      // Ensure engine is loaded before calling any function
      if (!this._engineLoaded) {
        return this.loadEngine().then(function () {
          return self.eval(script);
        });
      }

      return this.eval(script);
    }
  };


  // ── UI Helpers ──

  function setStepState(step, status) {
    var num = $("step" + step + "-num");
    var stat = $("step" + step + "-status");

    num.className = "step-num" +
      (status === "active" ? " active" : "") +
      (status === "done" ? " done" : "");

    var labels = {
      pending: "Waiting", active: "Active", running: "Running...",
      done: "Done", error: "Error"
    };
    stat.textContent = labels[status] || status;
    stat.className = "status status-" +
      (status === "active" || status === "running" ? "running" :
       status === "done" ? "done" :
       status === "error" ? "error" : "pending");
  }

  function show(id) { $(id).classList.remove("hidden"); }
  function hide(id) { $(id).classList.add("hidden"); }

  function addIssues(listId, items, type) {
    var list = $(listId);
    items.forEach(function (msg) {
      var li = document.createElement("li");
      li.className = type;
      li.textContent = msg;
      list.appendChild(li);
    });
    if (items.length > 0) show(listId);
  }


  // ── Step 1: Load Manifest ──

  $("btn-load").addEventListener("click", function () {
    // In UXP, use the file picker
    pickManifestFile().then(function (path) {
      if (!path) return;
      state.manifestPath = path;
      $("manifest-path").textContent = path;
      show("manifest-path");
      setStepState(1, "done");

      // Auto-advance to validation
      runValidation();
    }).catch(function (e) {
      setStepState(1, "error");
      console.error("File pick failed:", e);
    });
  });

  function pickManifestFile() {
    return new Promise(function (resolve, reject) {
      try {
        // UXP file picker
        if (typeof require !== "undefined") {
          var uxp = require("uxp");
          if (uxp && uxp.storage && uxp.storage.localFileSystem) {
            var fs = uxp.storage.localFileSystem;
            fs.getFileForOpening({
              types: ["json"],
              allowMultiple: false
            }).then(function (file) {
              if (file) {
                resolve(file.nativePath);
              } else {
                resolve(null);
              }
            }).catch(reject);
            return;
          }
        }

        // Fallback: use ExtendScript File.openDialog
        scriptBridge.eval(
          "var f = File.openDialog('Select manifest.json', 'JSON:*.json'); " +
          "f ? f.fsName : '';"
        ).then(function (result) {
          resolve(result || null);
        }).catch(reject);

      } catch (e) {
        reject(e);
      }
    });
  }


  // ── Step 2: Validate ──

  function runValidation() {
    setStepState(2, "running");

    scriptBridge.run("validateManifest", [state.manifestPath])
      .then(function (resultJSON) {
        var result = JSON.parse(resultJSON);
        state.validationResult = result;

        // Update stats
        var s = result.summary || {};
        $("val-total").textContent = s.totalItems || 0;
        $("val-valid").textContent = s.validItems || 0;
        $("val-fps").textContent = s.fps || 25;
        $("val-tracks").textContent = (s.tracksUsed || []).length;
        show("val-stats");

        // Show issues
        $("val-issues").innerHTML = "";
        if (result.errors.length > 0) addIssues("val-issues", result.errors, "error");
        if (result.warnings.length > 0) addIssues("val-issues", result.warnings, "warning");

        if (result.valid) {
          setStepState(2, "done");
          setStepState(3, "active");
          show("import-controls");
        } else {
          setStepState(2, "error");
        }
      })
      .catch(function (e) {
        setStepState(2, "error");
        console.error("Validation failed:", e);
      });
  }


  // ── Step 3: Import Media ──

  $("btn-import").addEventListener("click", function () {
    $("btn-import").disabled = true;
    setStepState(3, "running");

    scriptBridge.run("ingestMedia", [state.manifestPath])
      .then(function (resultJSON) {
        var result = JSON.parse(resultJSON);
        state.ingestResult = result;

        $("imp-done").textContent = result.imported || 0;
        $("imp-failed").textContent = result.failed ? result.failed.length : 0;
        show("import-stats");

        if ((result.failed || []).length === 0) {
          setStepState(3, "done");
        } else {
          setStepState(3, "done"); // Still done, but with warnings
          $("imp-failed").style.color = "var(--danger)";
        }

        setStepState(4, "active");
        show("timeline-controls");
        $("btn-import").disabled = false;
      })
      .catch(function (e) {
        setStepState(3, "error");
        $("btn-import").disabled = false;
        console.error("Import failed:", e);
      });
  });


  // ── Step 4: Build Timeline ──

  $("btn-timeline").addEventListener("click", function () {
    if (!state.ingestResult) return;
    $("btn-timeline").disabled = true;
    setStepState(4, "running");

    scriptBridge.run("buildTimeline", [
      state.manifestPath,
      JSON.stringify(state.ingestResult)
    ])
      .then(function (resultJSON) {
        var result = JSON.parse(resultJSON);
        state.timelineResult = result;

        $("tl-placed").textContent = result.placed || 0;
        $("tl-failed").textContent = result.failed || 0;
        show("timeline-stats");

        setStepState(4, "done");
        showReport(result);
        $("btn-timeline").disabled = false;
      })
      .catch(function (e) {
        setStepState(4, "error");
        $("btn-timeline").disabled = false;
        console.error("Timeline build failed:", e);
      });
  });


  // ── Step 5: Report ──

  function showReport(timelineResult) {
    show("step5");
    setStepState(5, "done");

    var lines = [];
    lines.push("=== IMPORT REPORT ===");
    lines.push("");

    var ing = state.ingestResult || {};
    lines.push("Media imported: " + (ing.imported || 0) + "/" + (ing.total || 0));
    if (ing.failed && ing.failed.length > 0) {
      lines.push("");
      lines.push("Failed imports:");
      ing.failed.forEach(function (f) {
        lines.push("  " + f.id + ": " + f.reason);
      });
    }

    lines.push("");
    lines.push("Timeline placed: " + (timelineResult.placed || 0));
    lines.push("Timeline failed: " + (timelineResult.failed || 0));
    lines.push("Timeline skipped: " + (timelineResult.skipped || 0));

    if (timelineResult.report && timelineResult.report.length > 0) {
      lines.push("");
      lines.push("Detail:");
      timelineResult.report.forEach(function (r) {
        var line = "  " + r.id + ": " + r.status;
        if (r.reason) line += " (" + r.reason + ")";
        if (r.track) line += " → " + r.track + " @ " + r.startSec.toFixed(2) + "s";
        lines.push(line);
      });
    }

    $("report-log").textContent = lines.join("\n");
  }

})();
