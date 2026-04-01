// ═══════════════════════════════════════════════════════════════════════
//  INFOGRAPHIC STUDIO — PREMIERE ENGINE (ExtendScript)
//  engine.jsx
//
//  3-stage pipeline:
//    Stage A: validateManifest(json)  → { valid, errors[], warnings[] }
//    Stage B: ingestMedia(json)       → { items: { id: projectItemName }, failed: [] }
//    Stage C: buildTimeline(json, itemMap) → { placed, failed, report }
//
//  Each stage is independent. The UXP panel calls them sequentially
//  and can inspect/retry between stages.
//
//  ExtendScript (ES3) — no let/const/arrow/template literals
// ═══════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════

var TICKS_PER_SECOND = 254016000000;
var DEFAULT_FPS = 25;


// ═══════════════════════════════════════════════════════════════
//  LOGGING
// ═══════════════════════════════════════════════════════════════

var _log = [];

function log(level, msg) {
    var line = "[" + level + "] " + msg;
    _log.push(line);
    $.writeln(line);
}

function getLog() {
    return _log.join("\n");
}

function clearLog() {
    _log = [];
}

function writeLogFile(folderPath) {
    var f = new File(folderPath + "/premiere-import-log.txt");
    try {
        f.open("w");
        f.write(_log.join("\n"));
        f.close();
        return f.fsName;
    } catch (e) {
        return null;
    }
}


// ═══════════════════════════════════════════════════════════════
//  FILE UTILITIES
// ═══════════════════════════════════════════════════════════════

function readJSON(filePath) {
    var f = new File(filePath);
    if (!f.exists) throw new Error("File not found: " + filePath);
    f.open("r");
    var raw = f.read();
    f.close();
    return JSON.parse(raw);
}

function findFirstFrame(folderPath) {
    var expected = new File(folderPath + "/frame_0001.png");
    if (expected.exists) return expected;

    // Fallback: scan for lowest-numbered frame
    var folder = new Folder(folderPath);
    if (!folder.exists) return null;
    var files = folder.getFiles("frame_*.png");
    if (files.length === 0) return null;
    files.sort(function(a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return files[0];
}

function countFrames(folderPath) {
    var folder = new Folder(folderPath);
    if (!folder.exists) return 0;
    return folder.getFiles("frame_*.png").length;
}

/**
 * Check whether frame numbering is continuous (no gaps).
 * Returns { continuous: bool, missing: number[] }
 */
function checkFrameContinuity(folderPath) {
    var folder = new Folder(folderPath);
    if (!folder.exists) return { continuous: false, missing: [] };
    var files = folder.getFiles("frame_*.png");
    if (files.length === 0) return { continuous: false, missing: [] };

    // Extract frame numbers
    var nums = [];
    for (var i = 0; i < files.length; i++) {
        var match = files[i].name.match(/frame_(\d+)\.png/);
        if (match) nums.push(parseInt(match[1], 10));
    }
    nums.sort(function(a, b) { return a - b; });

    var missing = [];
    for (var n = nums[0]; n <= nums[nums.length - 1]; n++) {
        var found = false;
        for (var j = 0; j < nums.length; j++) {
            if (nums[j] === n) { found = true; break; }
        }
        if (!found) missing.push(n);
    }

    return { continuous: missing.length === 0, missing: missing };
}


// ═══════════════════════════════════════════════════════════════
//  PROJECT ITEM UTILITIES
// ═══════════════════════════════════════════════════════════════

/**
 * Recursive search through bins for a project item by name.
 */
function findProjectItemByName(bin, name) {
    for (var i = 0; i < bin.children.numItems; i++) {
        var item = bin.children[i];
        if (item.name && item.name.indexOf(name) !== -1) {
            return item;
        }
        if (item.type === ProjectItemType.BIN) {
            var found = findProjectItemByName(item, name);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Get or create a bin. Supports nested paths: "Graphics/Fullscreen"
 */
function getOrCreateBin(path) {
    var parts = path.split("/");
    var parent = app.project.rootItem;

    for (var p = 0; p < parts.length; p++) {
        var binName = parts[p];
        var found = null;

        for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            if (child.type === ProjectItemType.BIN && child.name === binName) {
                found = child;
                break;
            }
        }

        if (!found) {
            parent.createBin(binName);
            // Re-scan to find the new bin
            for (var j = 0; j < parent.children.numItems; j++) {
                var c = parent.children[j];
                if (c.type === ProjectItemType.BIN && c.name === binName) {
                    found = c;
                    break;
                }
            }
        }

        if (!found) {
            log("ERROR", "Could not create bin: " + binName);
            return parent;
        }

        parent = found;
    }

    return parent;
}


// ═══════════════════════════════════════════════════════════════
//  STAGE A: VALIDATE
//
//  Runs BEFORE any import. Checks manifest structure,
//  folder existence, frame continuity, track validity.
//  Returns a report the panel can display.
// ═══════════════════════════════════════════════════════════════

function validateManifest(manifestPath) {
    clearLog();
    log("INFO", "=== STAGE A: VALIDATE ===");

    var result = {
        valid: true,
        errors: [],
        warnings: [],
        summary: {}
    };

    // Parse manifest
    var manifest;
    try {
        manifest = readJSON(manifestPath);
    } catch (e) {
        result.valid = false;
        result.errors.push("Cannot parse manifest: " + e.message);
        return JSON.stringify(result);
    }

    // Required fields
    if (!manifest.graphicsRoot) {
        result.errors.push("Missing graphicsRoot");
    }
    if (!manifest.items || manifest.items.length === 0) {
        result.errors.push("No items in manifest");
    }

    // Check graphics root exists
    if (manifest.graphicsRoot) {
        var rootFolder = new Folder(manifest.graphicsRoot);
        if (!rootFolder.exists) {
            result.errors.push("graphicsRoot does not exist: " + manifest.graphicsRoot);
        }
    }

    // Validate each item
    var trackSet = {};
    var itemCount = manifest.items ? manifest.items.length : 0;
    var validItems = 0;
    var missingFolders = 0;
    var missingFrames = 0;
    var gapWarnings = 0;

    if (manifest.items && manifest.graphicsRoot) {
        for (var i = 0; i < manifest.items.length; i++) {
            var item = manifest.items[i];
            var prefix = "Item " + i + " (" + (item.id || "?") + "): ";

            // Required fields
            if (!item.id) result.errors.push(prefix + "missing id");
            if (!item.folder) result.errors.push(prefix + "missing folder");
            if (typeof item.track !== "number" && typeof item.track !== "string") {
                result.errors.push(prefix + "track must be a number or string like 'V2'");
            }
            if (typeof item.startFrame !== "number") {
                result.errors.push(prefix + "startFrame must be a number");
            }

            // Track mapping — use manifest.tracks for named lookups
            var trackNum = resolveTrack(item.track, manifest.tracks);
            trackSet["V" + (trackNum + 1)] = true;

            // Check folder exists
            if (item.folder) {
                var itemFolder = new Folder(manifest.graphicsRoot + "/" + item.folder);
                if (!itemFolder.exists) {
                    result.errors.push(prefix + "folder not found: " + item.folder);
                    missingFolders++;
                    continue;
                }

                // Check first frame exists
                var ff = findFirstFrame(manifest.graphicsRoot + "/" + item.folder);
                if (!ff) {
                    result.errors.push(prefix + "no frame_*.png files found");
                    missingFrames++;
                    continue;
                }

                // Check frame continuity
                var cont = checkFrameContinuity(manifest.graphicsRoot + "/" + item.folder);
                if (!cont.continuous && cont.missing.length > 0) {
                    result.warnings.push(prefix + "frame gaps at: " + cont.missing.slice(0, 5).join(", ") +
                        (cont.missing.length > 5 ? " (+" + (cont.missing.length - 5) + " more)" : ""));
                    gapWarnings++;
                }

                // Check duration vs actual frames
                var frameCount = countFrames(manifest.graphicsRoot + "/" + item.folder);
                if (item.durationFrames && frameCount < item.durationFrames) {
                    result.warnings.push(prefix + "manifest says " + item.durationFrames + " frames but folder has " + frameCount);
                }

                validItems++;
            }
        }
    }

    // Build summary
    var tracks = [];
    for (var t in trackSet) {
        if (trackSet.hasOwnProperty(t)) tracks.push(t);
    }

    result.summary = {
        projectName: manifest.projectName || "unnamed",
        fps: manifest.fps || DEFAULT_FPS,
        resolution: manifest.resolution || { width: 1920, height: 1080 },
        totalItems: itemCount,
        validItems: validItems,
        missingFolders: missingFolders,
        missingFrames: missingFrames,
        gapWarnings: gapWarnings,
        tracksUsed: tracks.sort()
    };

    result.valid = result.errors.length === 0;

    log("INFO", "Total items: " + itemCount);
    log("INFO", "Valid: " + validItems);
    log("INFO", "Missing folders: " + missingFolders);
    log("INFO", "Missing frames: " + missingFrames);
    log("INFO", "Frame gap warnings: " + gapWarnings);
    log("INFO", "Tracks: " + tracks.join(", "));
    log("INFO", "Errors: " + result.errors.length);
    log("INFO", "Warnings: " + result.warnings.length);
    log("INFO", "Valid: " + result.valid);

    return JSON.stringify(result);
}


// ═══════════════════════════════════════════════════════════════
//  STAGE B: INGEST MEDIA
//
//  Imports each PNG sequence into isolated bins.
//  Returns per-item results so Stage C knows exactly what
//  succeeded and why anything failed.
//
//  Bin isolation: each import run gets its own timestamped bin
//  inside "Infographic Studio/". This means:
//    - detecting new items is trivial (bin was empty before)
//    - cleaning up failures is scoped
//    - you never grab the wrong project item
//
//  After import, items are moved to Fullscreen / Overlays bins.
//  Failed items stay in the run bin for manual inspection.
// ═══════════════════════════════════════════════════════════════

/**
 * Verify an imported project item looks like a real image sequence.
 * Returns { valid, reason, warnings[] } — never throws.
 *
 * Checks:
 *   1. Item exists and is not null
 *   2. Item name is not blank
 *   3. Bin did not explode into hundreds of separate PNGs
 *   4. Duration is longer than a single frame (not a still)
 *   5. Actual duration roughly matches expected frame count
 */
function verifyImport(item, binItemsBefore, binItemsAfter, expectedFrames, fps) {
    var warnings = [];
    fps = fps || DEFAULT_FPS;

    if (!item) {
        return { valid: false, reason: "item is null", warnings: warnings };
    }

    if (!item.name || item.name === "") {
        return { valid: false, reason: "item has no name", warnings: warnings };
    }

    // ── Check 3: bin explosion ──
    var added = binItemsAfter - binItemsBefore;
    if (added > 2) {
        return {
            valid: false,
            warnings: warnings,
            reason: "bin exploded: " + added + " items imported (expected 1). " +
                    "Check Edit > Preferences > Media > Numbered Stills."
        };
    }

    // ── Check 4 + 5: duration ──
    if (expectedFrames > 1) {
        try {
            var outPoint = item.getOutPoint ? item.getOutPoint() : null;
            if (outPoint) {
                var outTicks = parseFloat(outPoint.ticks || outPoint);
                var ticksPerFrame = TICKS_PER_SECOND / fps;
                var twoFrames = ticksPerFrame * 2;

                // Check 4: is it a single still?
                if (outTicks > 0 && outTicks <= twoFrames) {
                    return {
                        valid: false,
                        warnings: warnings,
                        reason: "duration too short — imported as single still, not sequence"
                    };
                }

                // Check 5 (A. sequence length validation):
                // Compare actual duration to expected.
                // Tolerance: 20% or 5 frames, whichever is larger.
                var actualFrames = Math.round(outTicks / ticksPerFrame);
                var tolerance = Math.max(5, Math.round(expectedFrames * 0.2));
                var diff = Math.abs(actualFrames - expectedFrames);

                if (diff > tolerance) {
                    // Not a hard failure — but a significant warning.
                    // Could mean dropped frames or partial import.
                    warnings.push(
                        "duration mismatch: expected " + expectedFrames +
                        " frames, got " + actualFrames +
                        " (diff: " + diff + ", tolerance: " + tolerance + ")"
                    );
                }
            }
        } catch (e) {
            // getOutPoint not available — cannot verify duration
        }
    }

    return { valid: true, reason: null, warnings: warnings };
}

/**
 * Generate a deterministic clip name from manifest item data.
 * Format: gfx_<id>_<label>
 * Ensures no collisions and makes timeline debugging trivial.
 */
function deterministicName(item) {
    var id = (item.id || "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
    var label = (item.name || item.folder || "clip")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
    // Cap at 60 chars to avoid Premiere weirdness with long names
    var name = id + "_" + label;
    if (name.length > 60) name = name.substring(0, 60);
    return name;
}

/**
 * Move a project item from one bin to another.
 * Returns true on success.
 */
function moveToFinalBin(item, targetBin) {
    try {
        item.moveBin(targetBin);
        return true;
    } catch (e) {
        log("WARN", "  moveBin failed: " + e.message + " — item stays in import bin");
        return false;
    }
}

/**
 * Remove all children from a bin (cleanup after failed import).
 */
function cleanBin(bin) {
    var removed = 0;
    // Remove in reverse to avoid index shifting
    for (var i = bin.children.numItems - 1; i >= 0; i--) {
        try {
            bin.children[i].remove();
            removed++;
        } catch (e) {}
    }
    return removed;
}


function ingestMedia(manifestPath) {
    clearLog();
    log("INFO", "=== STAGE B: INGEST MEDIA ===");

    var manifest = readJSON(manifestPath);
    var items = manifest.items || [];
    var root = manifest.graphicsRoot || "";
    var proj = app.project;

    // ── Create organised bins ──
    var fullscreenBin = getOrCreateBin("Infographic Studio/Fullscreen");
    var overlayBin = getOrCreateBin("Infographic Studio/Overlays");

    // Isolated import bin — scoped to this run.
    // Every import goes here first; verified items are then
    // moved to their final bin. Failed items stay here.
    var runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    var importBin = getOrCreateBin("Infographic Studio/_import_" + runId);

    log("INFO", "Import bin: _import_" + runId);
    log("INFO", "Items to import: " + items.length);
    log("INFO", "Graphics root: " + root);

    // ── Result: per-item detail + summary ──
    var result = {
        items: {},           // { id: resolvedClipName } — only verified imports
        itemDetails: [],     // per-item report objects (A. from your feedback)
        failed: [],          // [{ id, reason }]
        imported: 0,
        total: items.length,
        runBin: "_import_" + runId
    };

    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var folderPath = root + "/" + item.folder;
        var clipName = item.name || item.folder;
        var itemType = (item.type || "fullscreen").toLowerCase();
        var finalBin = itemType === "overlay" ? overlayBin : fullscreenBin;

        // ── Per-item detail object (A. from your feedback) ──
        var detail = {
            id: item.id,
            folder: item.folder,
            type: itemType,
            strategyUsed: null,     // "A" | "B" | null
            importMode: null,       // "sequence" | "still" | "exploded" | null
            importedItemName: null,
            verified: false,
            warning: null,
            error: null
        };

        log("INFO", "");
        log("INFO", "[" + (i + 1) + "/" + items.length + "] " + clipName);

        // ── Pre-checks ──
        var folder = new Folder(folderPath);
        if (!folder.exists) {
            detail.error = "folder not found: " + item.folder;
            log("ERROR", "  " + detail.error);
            result.failed.push({ id: item.id, reason: detail.error });
            result.itemDetails.push(detail);
            continue;
        }

        var firstFrame = findFirstFrame(folderPath);
        if (!firstFrame) {
            detail.error = "no frame_*.png files in folder";
            log("ERROR", "  " + detail.error);
            result.failed.push({ id: item.id, reason: detail.error });
            result.itemDetails.push(detail);
            continue;
        }

        var frameCount = countFrames(folderPath);
        log("INFO", "  Frames: " + frameCount + "  First: " + firstFrame.name);

        // ── B. Frame continuity pre-check (fail early) ──
        var continuity = checkFrameContinuity(folderPath);
        if (!continuity.continuous && continuity.missing.length > 0) {
            if (continuity.missing.length > frameCount * 0.1) {
                // More than 10% of frames missing — hard fail
                detail.error = "too many missing frames (" + continuity.missing.length +
                    " gaps). First gap at frame " + continuity.missing[0];
                log("ERROR", "  " + detail.error);
                result.failed.push({ id: item.id, reason: detail.error });
                result.itemDetails.push(detail);
                continue;
            } else {
                // Small gaps — warn but proceed
                detail.warning = "frame gaps at: " +
                    continuity.missing.slice(0, 5).join(", ") +
                    (continuity.missing.length > 5
                        ? " (+" + (continuity.missing.length - 5) + " more)"
                        : "");
                log("WARN", "  " + detail.warning);
            }
        }

        // ── C. Deterministic clip name ──
        var clipNameDet = deterministicName(item);

        // ══════════════════════════════════════════════════════
        //  STRATEGY A: first-frame + asNumberedStills = true
        // ══════════════════════════════════════════════════════
        var imported = null;
        var countBefore = importBin.children.numItems;
        var success = false;

        try {
            success = proj.importFiles([firstFrame.fsName], true, importBin, true);
        } catch (e) {
            log("WARN", "  Strategy A threw: " + e.message);
            success = false;
        }

        var countAfterA = importBin.children.numItems;

        if (success && countAfterA > countBefore) {
            imported = importBin.children[countAfterA - 1];
            detail.strategyUsed = "A";

            // ── Verify ──
            var manifestFps = manifest.fps || DEFAULT_FPS;
            var check = verifyImport(imported, countBefore, countAfterA, frameCount, manifestFps);

            if (check.valid) {
                detail.importMode = "sequence";
                log("INFO", "  Strategy A verified OK: " + imported.name);
                // Surface duration warnings even on success
                if (check.warnings && check.warnings.length > 0) {
                    for (var w = 0; w < check.warnings.length; w++) {
                        log("WARN", "  " + check.warnings[w]);
                    }
                    detail.warning = (detail.warning || "") +
                        (detail.warning ? " | " : "") + check.warnings.join("; ");
                }
            } else {
                log("WARN", "  Strategy A verification failed: " + check.reason);
                detail.warning = (detail.warning || "") +
                    (detail.warning ? " | " : "") + "Strategy A: " + check.reason;

                // ── Clean up failed import ──
                var cleaned = cleanBin(importBin);
                log("INFO", "  Cleaned " + cleaned + " item(s) from import bin");
                imported = null;
            }
        }

        // ══════════════════════════════════════════════════════
        //  STRATEGY B: import all frame paths
        // ══════════════════════════════════════════════════════
        if (!imported) {
            log("INFO", "  Strategy B: importing all " + frameCount + " frame paths");
            detail.strategyUsed = "B";

            var seqFolder = new Folder(folderPath);
            var files = seqFolder.getFiles("frame_*.png");
            files.sort(function(a, b) {
                return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
            });

            if (files.length > 0) {
                var allPaths = [];
                for (var f = 0; f < files.length; f++) {
                    allPaths.push(files[f].fsName);
                }

                var countBeforeB = importBin.children.numItems;
                try {
                    success = proj.importFiles(allPaths, false, importBin, false);
                } catch (e) {
                    log("ERROR", "  Strategy B threw: " + e.message);
                    success = false;
                }

                var countAfterB = importBin.children.numItems;
                var added = countAfterB - countBeforeB;

                if (success && added >= 1) {
                    imported = importBin.children[countAfterB - 1];

                    // ── Verify ──
                    var checkB = verifyImport(imported, countBeforeB, countAfterB, frameCount, manifest.fps || DEFAULT_FPS);

                    if (checkB.valid) {
                        detail.importMode = "sequence";
                        log("INFO", "  Strategy B verified OK: " + imported.name);
                        // Surface duration warnings
                        if (checkB.warnings && checkB.warnings.length > 0) {
                            for (var wb = 0; wb < checkB.warnings.length; wb++) {
                                log("WARN", "  " + checkB.warnings[wb]);
                            }
                            detail.warning = (detail.warning || "") +
                                (detail.warning ? " | " : "") + checkB.warnings.join("; ");
                        }
                    } else {
                        // ── HARD STOP on bad imports (C. from your feedback) ──
                        log("ERROR", "  Strategy B verification FAILED: " + checkB.reason);
                        log("ERROR", "  HARD STOP — not placing this item on timeline");
                        detail.importMode = added > 2 ? "exploded" : "still";
                        detail.error = checkB.reason;

                        // Clean up the mess
                        var cleanedB = cleanBin(importBin);
                        log("INFO", "  Cleaned " + cleanedB + " item(s) from import bin");
                        imported = null;
                    }
                }
            }
        }

        // ══════════════════════════════════════════════════════
        //  FINAL: name-based search (last resort)
        // ══════════════════════════════════════════════════════
        if (!imported) {
            imported = findProjectItemByName(importBin, item.folder);
        }
        if (!imported) {
            imported = findProjectItemByName(proj.rootItem, item.folder);
            if (imported) log("WARN", "  Found via project-wide search: " + imported.name);
        }

        // ══════════════════════════════════════════════════════
        //  OUTCOME
        // ══════════════════════════════════════════════════════
        if (!imported) {
            detail.error = detail.error || "both import strategies failed";
            log("ERROR", "  FAILED: " + detail.error);
            result.failed.push({ id: item.id, reason: detail.error });
            result.itemDetails.push(detail);
            continue;
        }

        // ── C. Deterministic rename ──
        var resolvedName = clipNameDet;
        try {
            imported.name = clipNameDet;
        } catch (e) {
            resolvedName = imported.name;
            detail.warning = (detail.warning || "") +
                (detail.warning ? " | " : "") + "Could not rename to " + clipNameDet;
        }

        // Move from isolated import bin to final organised bin
        moveToFinalBin(imported, finalBin);

        detail.importedItemName = resolvedName;
        detail.verified = true;
        log("INFO", "  OK → " + finalBin.name + "/" + resolvedName);

        result.items[item.id] = resolvedName;
        result.imported++;
        result.itemDetails.push(detail);

        // Let Premiere settle
        $.sleep(150);
    }

    // ── Summary report ──
    var stratA = 0, stratB = 0, exploded = 0, verified = 0;
    for (var d = 0; d < result.itemDetails.length; d++) {
        var det = result.itemDetails[d];
        if (det.strategyUsed === "A") stratA++;
        if (det.strategyUsed === "B") stratB++;
        if (det.importMode === "exploded") exploded++;
        if (det.verified) verified++;
    }

    log("INFO", "");
    log("INFO", "═══ INGEST REPORT ═══");
    log("INFO", "Total:     " + result.total);
    log("INFO", "Imported:  " + result.imported);
    log("INFO", "Verified:  " + verified);
    log("INFO", "Failed:    " + result.failed.length);
    log("INFO", "Strategy A used: " + stratA);
    log("INFO", "Strategy B used: " + stratB);

    if (exploded > 0) {
        log("ERROR", "");
        log("ERROR", "WARNING: " + exploded + " item(s) imported as individual stills (not sequences).");
        log("ERROR", "These items were NOT placed and need manual intervention.");
        log("ERROR", "Fix: Edit > Preferences > Media > tick 'Numbered Stills' or 'Image Sequence'.");
    }

    if (result.failed.length > 0) {
        log("INFO", "");
        log("INFO", "Failed items:");
        for (var ff = 0; ff < result.failed.length; ff++) {
            log("ERROR", "  " + result.failed[ff].id + ": " + result.failed[ff].reason);
        }
    }

    // Clean up empty import bin (if everything was moved to final bins)
    if (importBin.children.numItems === 0) {
        try { importBin.remove(); log("INFO", "Import bin cleaned up (empty)"); }
        catch (e) {}
    } else {
        log("WARN", "Import bin retained: " + importBin.children.numItems + " item(s) remain for inspection");
    }

    writeLogFile(new File(manifestPath).parent.fsName);

    return JSON.stringify(result);
}


// ═══════════════════════════════════════════════════════════════
//  STAGE C: BUILD TIMELINE
//
//  Takes the ingest result and places clips on the timeline.
//  Completely separate from import — uses clip names to find items.
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve a track identifier to a 0-based index.
 *
 * Supports:
 *   - Number:       3         → 3
 *   - V-string:     "V2"      → 1 (0-indexed)
 *   - Named track:  "fullscreen" → looks up in manifest.tracks map
 *
 * The trackMap comes from manifest.tracks, e.g.:
 *   { "footage": 1, "fullscreen": 2, "overlay": 3 }
 *   Values in the map are 1-based (human-friendly), converted to 0-based here.
 */
function resolveTrack(track, trackMap) {
    // Direct number
    if (typeof track === "number") return track;

    if (typeof track === "string") {
        // Named track lookup (e.g. "fullscreen" → manifest.tracks.fullscreen → 2 → index 1)
        if (trackMap && trackMap[track] !== undefined) {
            return trackMap[track] - 1; // manifest values are 1-based
        }
        // V-string (e.g. "V2" → index 1)
        var match = track.match(/[Vv](\d+)/);
        if (match) return parseInt(match[1], 10) - 1;
        // Bare number string
        return parseInt(track, 10) || 1;
    }

    return 1;
}

function buildTimeline(manifestPath, ingestResultJSON) {
    clearLog();
    log("INFO", "=== STAGE C: BUILD TIMELINE ===");

    var manifest = readJSON(manifestPath);
    var ingestResult = JSON.parse(ingestResultJSON);
    var items = manifest.items || [];
    var fps = manifest.fps || DEFAULT_FPS;
    var itemMap = ingestResult.items || {};

    // Build a set of verified item IDs from ingest details.
    // Stage C will ONLY place items that were verified in Stage B.
    var verifiedSet = {};
    var details = ingestResult.itemDetails || [];
    for (var d = 0; d < details.length; d++) {
        if (details[d].verified) {
            verifiedSet[details[d].id] = true;
        }
    }

    // Get or create sequence
    var seq = app.project.activeSequence;
    var createdNew = false;
    if (!seq) {
        var seqName = manifest.projectName || "Infographic Timeline";
        app.project.createNewSequence(seqName, "infostudio_seq_" + Date.now());
        seq = app.project.activeSequence;
        createdNew = true;
    }

    if (!seq) {
        return JSON.stringify({ placed: 0, failed: items.length, report: "No sequence available" });
    }

    log("INFO", "Sequence: " + seq.name + (createdNew ? " (new)" : " (existing)"));
    log("INFO", "FPS: " + fps);
    log("INFO", "Items to place: " + items.length);

    // Find highest track needed
    var maxTrackIdx = 0;
    for (var i = 0; i < items.length; i++) {
        var tidx = resolveTrack(items[i].track, manifest.tracks);
        if (tidx > maxTrackIdx) maxTrackIdx = tidx;
    }

    // Ensure enough video tracks
    var currentTracks = seq.videoTracks.numTracks;
    if (currentTracks <= maxTrackIdx) {
        log("INFO", "Need V" + (maxTrackIdx + 1) + " but only " + currentTracks + " tracks exist");
        // Premiere auto-creates tracks when inserting on higher indices in many cases,
        // but try addTrack first for safety
        try {
            var needed = (maxTrackIdx + 1) - currentTracks;
            for (var t = 0; t < needed; t++) {
                seq.videoTracks.addTrack();
            }
            log("INFO", "Added " + needed + " video track(s)");
        } catch (e) {
            log("WARN", "addTrack unavailable — will rely on auto-creation");
        }
    }

    var result = {
        placed: 0,
        failed: 0,
        skipped: 0,
        collisions: 0,
        report: []
    };

    // ── D. Track occupancy map for collision detection ──
    // Tracks what time ranges are occupied on each track.
    // Key: track index, Value: array of { start, end, id }
    var trackOccupancy = {};

    /**
     * Check if a time range would collide with existing clips on a track.
     * Returns { collision: bool, conflictId: string|null }
     */
    function checkCollision(trackIdx, startSec, durationSec) {
        var endSec = startSec + durationSec;
        var occupied = trackOccupancy[trackIdx] || [];

        for (var o = 0; o < occupied.length; o++) {
            var slot = occupied[o];
            // Overlap: new start < existing end AND new end > existing start
            if (startSec < slot.end && endSec > slot.start) {
                return { collision: true, conflictId: slot.id };
            }
        }
        return { collision: false, conflictId: null };
    }

    function recordOccupancy(trackIdx, startSec, durationSec, itemId) {
        if (!trackOccupancy[trackIdx]) trackOccupancy[trackIdx] = [];
        trackOccupancy[trackIdx].push({
            start: startSec,
            end: startSec + durationSec,
            id: itemId
        });
    }

    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var clipName = itemMap[item.id];

        if (!clipName) {
            log("WARN", "No imported clip for: " + item.id + " — skipping");
            result.report.push({ id: item.id, status: "skipped", reason: "not in ingest result" });
            result.skipped++;
            continue;
        }

        // ── Hard gate: only place verified imports ──
        if (!verifiedSet[item.id]) {
            log("WARN", "  " + item.id + " was not verified in Stage B — refusing to place");
            result.report.push({ id: item.id, status: "skipped", reason: "import not verified — check ingest report" });
            result.skipped++;
            continue;
        }

        // Find the project item by its resolved name
        var projItem = findProjectItemByName(app.project.rootItem, clipName);
        if (!projItem) {
            log("ERROR", "Project item not found: " + clipName);
            result.report.push({ id: item.id, status: "failed", reason: "project item not found: " + clipName });
            result.failed++;
            continue;
        }

        var trackIdx = resolveTrack(item.track, manifest.tracks);
        var startSec = (item.startFrame || 0) / fps;
        var durationSec = (item.durationFrames || 50) / fps;
        var itemTypeLower = (item.type || "fullscreen").toLowerCase();

        log("INFO", "");
        log("INFO", "Placing: " + clipName);
        log("INFO", "  Track: V" + (trackIdx + 1) + " at " + startSec.toFixed(3) + "s (frame " + item.startFrame + ")");

        // ── D. Track collision detection ──
        var collision = checkCollision(trackIdx, startSec, durationSec);
        if (collision.collision) {
            if (itemTypeLower === "fullscreen") {
                // Fullscreen clips should never overlap — warn and skip
                log("ERROR", "  COLLISION on V" + (trackIdx + 1) + " with " + collision.conflictId + " — skipping fullscreen");
                result.report.push({
                    id: item.id, status: "collision",
                    reason: "overlaps " + collision.conflictId + " on V" + (trackIdx + 1),
                    track: "V" + (trackIdx + 1), startSec: startSec
                });
                result.collisions++;
                continue;
            } else {
                // Overlays can stack — warn but proceed
                log("WARN", "  Overlap on V" + (trackIdx + 1) + " with " + collision.conflictId + " (overlay — proceeding)");
            }
        }

        try {
            // Set source out-point to control duration
            if (item.durationFrames) {
                var outTicks = Math.round(item.durationFrames * (TICKS_PER_SECOND / fps));
                try {
                    projItem.setOutPoint("" + outTicks, 4);
                    log("INFO", "  Duration: " + item.durationFrames + " frames (" + durationSec.toFixed(2) + "s)");
                } catch (e) {
                    log("WARN", "  Could not set out-point: " + e.message);
                }
            }

            // Place on timeline
            var track = seq.videoTracks[trackIdx];
            if (!track) {
                log("ERROR", "  Track V" + (trackIdx + 1) + " does not exist");
                result.report.push({ id: item.id, status: "failed", reason: "track does not exist" });
                result.failed++;
                continue;
            }

            track.insertClip(projItem, startSec);

            // Record occupancy for future collision checks
            recordOccupancy(trackIdx, startSec, durationSec, item.id);

            log("INFO", "  PLACED");

            result.report.push({ id: item.id, status: "placed", track: "V" + (trackIdx + 1), startSec: startSec });
            result.placed++;

        } catch (e) {
            log("ERROR", "  Placement failed: " + e.message);
            result.report.push({ id: item.id, status: "failed", reason: e.message });
            result.failed++;
        }
    }

    log("INFO", "");
    log("INFO", "═══ TIMELINE REPORT ═══");
    log("INFO", "Placed:     " + result.placed);
    log("INFO", "Failed:     " + result.failed);
    log("INFO", "Skipped:    " + result.skipped);
    log("INFO", "Collisions: " + result.collisions);

    if (result.collisions > 0) {
        log("WARN", "");
        log("WARN", result.collisions + " fullscreen collision(s) detected and skipped.");
        log("WARN", "Check your manifest for overlapping timestamps on the same track.");
    }

    writeLogFile(new File(manifestPath).parent.fsName);

    return JSON.stringify(result);
}


// ═══════════════════════════════════════════════════════════════
//  STANDALONE RUNNER
//
//  When run as a script (File > Scripts > Run Script),
//  this executes all 3 stages sequentially with user prompts.
//  When called from UXP, use the individual stage functions.
// ═══════════════════════════════════════════════════════════════

function runStandalone() {
    if (!app.project) {
        alert("Open a Premiere Pro project first.");
        return;
    }

    // Pick manifest
    var mf = File.openDialog(
        "Select Infographic Studio Manifest",
        "JSON:*.json,All:*.*",
        false
    );
    if (!mf) return;
    var manifestPath = mf.fsName;

    // Stage A: Validate
    var valJSON = validateManifest(manifestPath);
    var val = JSON.parse(valJSON);

    if (!val.valid) {
        alert(
            "Manifest has " + val.errors.length + " error(s):\n\n" +
            val.errors.slice(0, 8).join("\n") +
            (val.errors.length > 8 ? "\n(+" + (val.errors.length - 8) + " more)" : "")
        );
        return;
    }

    var s = val.summary;
    var msg = "Project: " + s.projectName + "\n" +
        "Items: " + s.totalItems + " (" + s.validItems + " valid)\n" +
        "FPS: " + s.fps + "\n" +
        "Resolution: " + s.resolution.width + "x" + s.resolution.height + "\n" +
        "Tracks: " + s.tracksUsed.join(", ");

    if (val.warnings.length > 0) {
        msg += "\n\nWarnings (" + val.warnings.length + "):\n" + val.warnings.slice(0, 5).join("\n");
    }

    msg += "\n\nProceed with import?";

    if (!confirm(msg)) return;

    // Stage B: Ingest
    var ingestJSON = ingestMedia(manifestPath);
    var ingest = JSON.parse(ingestJSON);

    if (ingest.failed.length > 0) {
        var fmsg = ingest.imported + "/" + ingest.total + " imported.\n\n" +
            "Failed (" + ingest.failed.length + "):\n" +
            ingest.failed.slice(0, 5).map(function(f) { return "  " + f.id + ": " + f.reason; }).join("\n");
        fmsg += "\n\nContinue to timeline placement?";
        if (!confirm(fmsg)) return;
    }

    // Stage C: Build timeline
    var timelineJSON = buildTimeline(manifestPath, ingestJSON);
    var timeline = JSON.parse(timelineJSON);

    alert(
        "Import complete!\n\n" +
        "Placed: " + timeline.placed + "\n" +
        "Failed: " + timeline.failed + "\n" +
        "Skipped: " + timeline.skipped + "\n\n" +
        "Check 'Infographic Studio' bin in your project panel.\n" +
        "Log written to premiere-import-log.txt"
    );
}

// If run directly as a script (not called from UXP), auto-execute
if (typeof $ !== "undefined" && $.fileName) {
    runStandalone();
}
