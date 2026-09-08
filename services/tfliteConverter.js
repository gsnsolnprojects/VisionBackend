const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

/**
 * TFLite Converter Service
 *
 * Provides functionality to:
 * - Convert PyTorch (.pt) models to TFLite (.tflite) format, for on-device
 *   mobile inference (see corrosionmobileapp's react-native-fast-tflite usage)
 * - Check if a TFLite variant exists
 * - Get or create a TFLite file for a model
 */

const TFLITE_VARIANTS = ['float16', 'float32'];

function tfliteDir(model) {
  return path.join(model.storagePath, 'tflite');
}

function tflitePath(model, variant) {
  return path.join(tfliteDir(model), `best_${variant}.tflite`);
}

/**
 * Convert PyTorch model to TFLite format (produces float16 + float32 variants).
 * @param {string} ptModelPath - Path to .pt model file
 * @param {string} outputDir - Directory where the .tflite files should be saved
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function convertToTflite(ptModelPath, outputDir) {
  try {
    if (!fs.existsSync(ptModelPath)) {
      return {
        success: false,
        error: `PyTorch model file not found: ${ptModelPath}`
      };
    }

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const pythonScriptPath = path.join(__dirname, '../scripts/convert-to-tflite.py');

    if (!fs.existsSync(pythonScriptPath)) {
      return {
        success: false,
        error: `TFLite conversion script not found: ${pythonScriptPath}`
      };
    }

    console.log(`🔄 Converting model to TFLite: ${ptModelPath} -> ${outputDir}`);

    const command = `python "${pythonScriptPath}" --input "${ptModelPath}" --output-dir "${outputDir}"`;

    // TFLite export goes PyTorch -> ONNX -> TensorFlow -> TFLite internally,
    // so it's slower than the direct ONNX export — give it more headroom.
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 900000 // 15 minutes
    });

    if (stdout) {
      console.log(stdout);
    }
    if (stderr && !stderr.includes('ERROR')) {
      console.warn(stderr);
    }

    const producedAny = TFLITE_VARIANTS.some((variant) =>
      fs.existsSync(path.join(outputDir, `best_${variant}.tflite`))
    );

    if (!producedAny) {
      return {
        success: false,
        error: 'No .tflite files were found in the conversion output'
      };
    }

    console.log(`✅ TFLite conversion successful: ${outputDir}`);
    return { success: true };

  } catch (error) {
    console.error('Error converting to TFLite:', error);
    return {
      success: false,
      error: error.message || 'Unknown error during TFLite conversion'
    };
  }
}

/**
 * Get or create a TFLite file for a model.
 * @param {Object} model - Model document from MongoDB
 * @param {string} variant - 'float16' or 'float32'
 * @returns {Promise<{success: boolean, path?: string, error?: string}>}
 */
async function getOrCreateTflite(model, variant = 'float16') {
  try {
    if (!TFLITE_VARIANTS.includes(variant)) {
      return { success: false, error: `Invalid variant: ${variant}` };
    }

    const outPath = tflitePath(model, variant);

    if (fs.existsSync(outPath)) {
      return { success: true, path: outPath };
    }

    const ptModelPath = model.bestCheckpointPath || path.join(model.storagePath, 'best.pt');
    if (!fs.existsSync(ptModelPath)) {
      return { success: false, error: `PyTorch model file not found: ${ptModelPath}` };
    }

    const conversionResult = await convertToTflite(ptModelPath, tfliteDir(model));
    if (!conversionResult.success) {
      return conversionResult;
    }

    if (!fs.existsSync(outPath)) {
      return {
        success: false,
        error: `Conversion succeeded but the "${variant}" variant was not produced`
      };
    }

    return { success: true, path: outPath };

  } catch (error) {
    console.error('Error getting or creating TFLite:', error);
    return {
      success: false,
      error: error.message || 'Unknown error'
    };
  }
}

/**
 * Check if a TFLite variant already exists for a model.
 * @param {Object} model - Model document from MongoDB
 * @param {string} variant - 'float16' or 'float32'
 * @returns {boolean}
 */
function tfliteExists(model, variant = 'float16') {
  try {
    return fs.existsSync(tflitePath(model, variant));
  } catch (error) {
    return false;
  }
}

module.exports = {
  convertToTflite,
  getOrCreateTflite,
  tfliteExists,
  tflitePath,
  TFLITE_VARIANTS
};
