const fs = require('fs').promises;
const path = require('path');
const { existsSync, mkdirSync } = require('fs');
const { BlobServiceClient } = require('@azure/storage-blob');

/**
 * Storage Adapter - Abstracts file storage operations
 * 
 * This adapter allows switching between:
 * - Local filesystem (current implementation)
 * - Azure Blob Storage (stub for future)
 * - AWS S3 (can be added later)
 * 
 * Why use an adapter? It keeps storage logic separate from business logic,
 * making it easy to switch storage backends without changing other code.
 */

class StorageAdapter {
  constructor(mode = 'local') {
    this.mode = mode;
    this.basePath = path.join(process.cwd(), 'datasets');
    
    // ✅ Ensure base directory exists
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
    }

    // Initialize Azure Blob Service Client if in Azure mode
    if (this.mode === 'azure') {
      const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
      if (!connectionString) {
        throw new Error('AZURE_STORAGE_CONNECTION_STRING environment variable is required for Azure storage mode');
      }
      this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    }
  }

  /**
   * Ensure a directory exists (create if it doesn't)
   * @param {string} dirPath - Full directory path
   */
  async ensureDir(dirPath) {
    if (this.mode === 'local') {
      // ✅ Recursive: true creates all parent directories if needed
      await fs.mkdir(dirPath, { recursive: true });
    } else if (this.mode === 'azure') {
      // NO-OP for Azure Blob Storage (containers are created automatically)
      return true;
    }
  }

  /**
   * Check if a file or directory exists
   * @param {string} filePath - Path to check
   * @returns {boolean}
   */
  async exists(filePath) {
    if (this.mode === 'local') {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    } else if (this.mode === 'azure') {
      const { containerName, blobName } = this._parseAzurePath(filePath);
      const containerClient = this.blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);
      return await blobClient.exists();
    }
  }

  /**
   * Read a file and return its buffer
   * @param {string} filePath - Path to file
   * @returns {Promise<Buffer>} File content as buffer
   */
  async readFile(filePath) {
    if (this.mode === 'local') {
      return await fs.readFile(filePath);
    } else if (this.mode === 'azure') {
      const { containerName, blobName } = this._parseAzurePath(filePath);
      const containerClient = this.blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);
      const downloadResponse = await blobClient.download();
      const buffer = await this._streamToBuffer(downloadResponse.readableStreamBody);
      return buffer;
    }
  }

  /**
   * Convert a readable stream to buffer
   * @param {NodeJS.ReadableStream} stream - Readable stream
   * @returns {Promise<Buffer>} Buffer containing stream data
   * @private
   */
  async _streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  /**
   * Save a file from temporary location to final destination
   * 
   * ⚠️ CAUTION: This moves files across directories. On some systems (especially
   * when temp and destination are on different drives), fs.rename might fail.
   * We handle this by falling back to copy + delete.
   * 
   * @param {string} srcTempPath - Source file path (temporary upload location)
   * @param {string} destPath - Destination file path (final storage location)
   */
  async saveFile(srcTempPath, destPath) {
    if (this.mode === 'local') {
      // ✅ Ensure destination directory exists
      const destDir = path.dirname(destPath);
      await this.ensureDir(destDir);

      try {
        // ✅ Try rename first (fast, atomic on same filesystem)
        await fs.rename(srcTempPath, destPath);
      } catch (error) {
        // ⚠️ If rename fails (cross-device), use copy + delete
        if (error.code === 'EXDEV') {
          // Copy file
          await fs.copyFile(srcTempPath, destPath);
          // Delete temp file
          await fs.unlink(srcTempPath);
        } else {
          throw error;
        }
      }
    } else if (this.mode === 'azure') {
      const { containerName, blobName } = this._parseAzurePath(destPath);
      const containerClient = this.blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      
      // Read local temp file
      const fileBuffer = await fs.readFile(srcTempPath);
      
      // Upload buffer to Azure Blob Storage
      await blockBlobClient.upload(fileBuffer, fileBuffer.length, {
        overwrite: true
      });
      
      // Delete temp file after upload
      await fs.unlink(srcTempPath);
    }
  }

  /**
   * Move a file from source to destination
   * 
   * This is a wrapper around saveFile but with a clearer name for moving
   * files within the storage system (not from temp uploads).
   * 
   * ⚠️ CAUTION: Handles cross-device moves by falling back to copy + delete.
   * 
   * @param {string} srcPath - Source file path
   * @param {string} destPath - Destination file path
   */
  async moveFile(srcPath, destPath) {
    if (this.mode === 'local') {
      // ✅ Ensure destination directory exists
      const destDir = path.dirname(destPath);
      await this.ensureDir(destDir);

      try {
        // ✅ Try rename first (fast, atomic on same filesystem)
        await fs.rename(srcPath, destPath);
      } catch (error) {
        // ⚠️ If rename fails (cross-device), use copy + delete
        if (error.code === 'EXDEV') {
          // Copy file
          await fs.copyFile(srcPath, destPath);
          // Delete source file
          await fs.unlink(srcPath);
        } else {
          throw error;
        }
      }
    } else if (this.mode === 'azure') {
      // TODO: Move blob in Azure Blob Storage
      // const srcContainer = this.extractContainerName(srcPath);
      // const srcBlob = this.extractBlobName(srcPath);
      // const destContainer = this.extractContainerName(destPath);
      // const destBlob = this.extractBlobName(destPath);
      // await azureBlobService.moveBlob(srcContainer, srcBlob, destContainer, destBlob);
      throw new Error('Azure storage not yet implemented');
    }
  }

  /**
   * Get base storage path
   * @returns {string} Base path (e.g., /datasets)
   */
  getBasePath() {
    return this.basePath;
  }

  /**
   * Build storage path for a dataset
   * Format: /datasets/{company}/{project}/{version}/
   */
  buildDatasetPath(company, project, version) {
    return path.join(this.basePath, company, project, version);
  }

  /**
   * Build path for images folder
   */
  buildImagesPath(company, project, version) {
    return path.join(this.buildDatasetPath(company, project, version), 'images');
  }

  /**
   * Build path for labels folder
   */
  buildLabelsPath(company, project, version) {
    return path.join(this.buildDatasetPath(company, project, version), 'labels');
  }

  /**
   * Build path for thumbnails folder
   */
  buildThumbnailsPath(company, project, version) {
    return path.join(this.buildDatasetPath(company, project, version), 'thumbnails');
  }

  /**
   * Get full path to a thumbnail file
   * @param {string} company - Company identifier
   * @param {string} project - Project identifier
   * @param {string} version - Version identifier
   * @param {string} storedName - Stored filename (without thumb_ prefix)
   * @returns {string} Full path to thumbnail file
   */
  getThumbnailPath(company, project, version, storedName) {
    const thumbnailsPath = this.buildThumbnailsPath(company, project, version);
    return path.join(thumbnailsPath, `thumb_${storedName}`);
  }

  /**
   * Folder of an existing dataset: its stored storagePath, falling back to the
   * company/project/version layout. Use this (not buildDatasetPath) for datasets that
   * already exist: the stored path survives project renames and points linked sample
   * datasets at GSN's shared copy.
   * @param {{ storagePath?: string, company: string, project: string, version: string }} dataset
   */
  datasetRoot(dataset) {
    return dataset.storagePath || this.buildDatasetPath(dataset.company, dataset.project, dataset.version);
  }

  datasetImagesPath(dataset) {
    return path.join(this.datasetRoot(dataset), 'images');
  }

  datasetLabelsPath(dataset) {
    return path.join(this.datasetRoot(dataset), 'labels');
  }

  datasetThumbnailsPath(dataset) {
    return path.join(this.datasetRoot(dataset), 'thumbnails');
  }

  datasetThumbnailPath(dataset, storedName) {
    return path.join(this.datasetThumbnailsPath(dataset), `thumb_${storedName}`);
  }

  /**
   * Build storage path for inference results
   * Format: /results/{company}/{project}/{modelId}/inference_{inferenceId}/
   * @param {string} company - Company identifier
   * @param {string} project - Project identifier
   * @param {string} modelId - Model identifier (from Model model)
   * @param {string} inferenceId - Inference job identifier
   * @returns {string} Full path to results folder
   */
  buildResultsPath(company, project, modelId, inferenceId) {
    const resultsBasePath = path.join(process.cwd(), 'results');
    return path.join(resultsBasePath, company, project, modelId, `inference_${inferenceId}`);
  }

  /**
   * Build path for annotated images subfolder within results
   * Format: {resultsPath}/annotated/
   * @param {string} resultsPath - Base results path (from buildResultsPath)
   * @returns {string} Full path to annotated images folder
   */
  buildAnnotatedImagesPath(resultsPath) {
    return path.join(resultsPath, 'annotated');
  }

  /**
   * Build path for metadata JSON file within results
   * Format: {resultsPath}/metadata.json
   * @param {string} resultsPath - Base results path (from buildResultsPath)
   * @returns {string} Full path to metadata JSON file
   */
  buildMetadataPath(resultsPath) {
    return path.join(resultsPath, 'metadata.json');
  }

  /**
   * Copy a file from source to destination (preserves original)
   * 
   * This is used when we need to keep the original file intact
   * (e.g., preserving folder structure for dashboard while copying to train/val)
   * 
   * @param {string} srcPath - Source file path
   * @param {string} destPath - Destination file path
   */
  async copyFile(srcPath, destPath) {
    if (this.mode === 'local') {
      // ✅ Ensure destination directory exists
      const destDir = path.dirname(destPath);
      await this.ensureDir(destDir);

      // ✅ Copy file (does not delete source)
      await fs.copyFile(srcPath, destPath);
    } else if (this.mode === 'azure') {
      console.log('[StorageAdapter][Azure] copyFile:', srcPath, '→', destPath);
      
      const { containerName: srcContainer, blobName: srcBlob } = this._parseAzurePath(srcPath);
      const { containerName: destContainer, blobName: destBlob } = this._parseAzurePath(destPath);
      
      const srcContainerClient = this.blobServiceClient.getContainerClient(srcContainer);
      const srcBlobClient = srcContainerClient.getBlobClient(srcBlob);
      
      const destContainerClient = this.blobServiceClient.getContainerClient(destContainer);
      const destBlobClient = destContainerClient.getBlockBlobClient(destBlob);
      
      // Get source blob URL
      const srcBlobUrl = srcBlobClient.url;
      
      // Start async copy operation
      const copyOperation = await destBlobClient.beginCopyFromURL(srcBlobUrl);
      
      // Wait for copy to complete
      await copyOperation.pollUntilDone();
    }
  }

  /**
   * Rename a directory (folder rename - instant on same filesystem)
   * 
   * Used when renaming company/project - renames the folder instead of moving files
   * This is much faster than copying files (instant vs minutes for large datasets)
   * 
   * @param {string} srcDir - Source directory path (e.g., /datasets/company/oldProject/)
   * @param {string} destDir - Destination directory path (e.g., /datasets/company/newProject/)
   */
  async renameDirectory(srcDir, destDir) {
    if (this.mode === 'local') {
      // ✅ Check if source exists
      if (!(await this.exists(srcDir))) {
        throw new Error(`Source directory does not exist: ${srcDir}`);
      }

      // ✅ Ensure parent directory of destination exists
      const destParent = path.dirname(destDir);
      await this.ensureDir(destParent);

      try {
        // ✅ Use rename (instant on same filesystem - just changes folder name)
        // This is the key: fs.rename() on directories is instant, no file copying!
        await fs.rename(srcDir, destDir);
        console.log(`✅ Renamed directory: ${srcDir} → ${destDir}`);
      } catch (error) {
        // ⚠️ If rename fails (cross-device), fall back to copy + delete
        // This only happens if source and dest are on different drives
        if (error.code === 'EXDEV') {
          console.warn(`⚠️ Cross-device rename detected, using copy+delete fallback`);
          // Recursively copy directory
          await this._copyDirectoryRecursive(srcDir, destDir);
          // Delete source directory
          await this._removeDirectoryRecursive(srcDir);
        } else {
          throw error;
        }
      }

      // ✅ Clean up empty parent directories after rename
      await this._cleanupEmptyParents(srcDir);
    } else if (this.mode === 'azure') {
      // TODO: Rename directory in Azure Blob Storage (metadata-only operation)
      throw new Error('Azure storage not yet implemented');
    }
  }

  /**
   * Move an entire directory from source to destination
   * 
   * @deprecated Use renameDirectory() instead - it's faster (instant rename vs file copying)
   * Kept for backward compatibility
   * 
   * @param {string} srcDir - Source directory path
   * @param {string} destDir - Destination directory path
   */
  async moveDirectory(srcDir, destDir) {
    // ✅ Delegate to renameDirectory (same operation, better name)
    return this.renameDirectory(srcDir, destDir);
  }

  /**
   * Copy an entire directory (recursively) from source to destination, leaving the source
   * intact. Unlike renameDirectory/moveDirectory, this does NOT remove the source — used for
   * duplicating a dataset version into a new independent copy.
   * @param {string} srcDir - Source directory path
   * @param {string} destDir - Destination directory path
   */
  async copyDirectory(srcDir, destDir) {
    if (this.mode === 'local') {
      if (!(await this.exists(srcDir))) {
        throw new Error(`Source directory does not exist: ${srcDir}`);
      }
      await this._copyDirectoryRecursive(srcDir, destDir);
    } else if (this.mode === 'azure') {
      const files = await this.listFiles(srcDir);
      for (const file of files) {
        const destPath = destDir + file.blobPath.slice(srcDir.length);
        await this.copyFile(file.blobPath, destPath);
      }
    }
  }

  /**
   * List files/blobs under a prefix
   * @param {string} prefix - Path prefix to list (e.g., "datasets/company/project/images/train/")
   * @returns {Promise<Array<{blobPath: string, name: string, size: number}>>}
   */
  async listFiles(prefix) {
    if (this.mode === 'local') {
      throw new Error('listFiles not implemented for local mode');
    } else if (this.mode === 'azure') {
      const { containerName, blobName: prefixBlobName } = this._parseAzurePath(prefix);
      const containerClient = this.blobServiceClient.getContainerClient(containerName);
      
      const files = [];
      for await (const blob of containerClient.listBlobsFlat({ prefix: prefixBlobName })) {
        const fullBlobPath = `${containerName}/${blob.name}`;
        files.push({
          blobPath: fullBlobPath,
          name: blob.name,
          size: blob.properties.contentLength || 0
        });
      }
      
      return files;
    }
  }

  /**
   * Save a buffer directly to storage
   * @param {Buffer} buffer - Buffer to save
   * @param {string} destPath - Destination path
   */
  async saveBuffer(buffer, destPath) {
    if (this.mode === 'local') {
      const destDir = path.dirname(destPath);
      await this.ensureDir(destDir);
      await fs.writeFile(destPath, buffer);
    } else if (this.mode === 'azure') {
      const { containerName, blobName } = this._parseAzurePath(destPath);
      const containerClient = this.blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      
      await blockBlobClient.upload(buffer, buffer.length, {
        overwrite: true
      });
    }
  }

  /**
   * Parse Azure path to extract container name and blob name
   * Supports both absolute and relative paths
   * @param {string} filePath - Path to parse (e.g., "datasets/company/project/file.jpg" or "C:/path/datasets/company/file.jpg")
   * @returns {{containerName: string, blobName: string}}
   * @private
   */
  _parseAzurePath(filePath) {
    // Normalize path separators (handle both / and \)
    const normalizedPath = filePath.replace(/\\/g, '/');
    
    // Find container folder anywhere in the path (not just at start)
    // This supports both absolute paths like "C:/path/datasets/..." and relative paths like "datasets/..."
    let containerName;
    let blobName;
    
    if (normalizedPath.includes('/datasets/')) {
      containerName = 'datasets';
      const containerIndex = normalizedPath.indexOf('/datasets/');
      blobName = normalizedPath.substring(containerIndex + '/datasets/'.length);
    } else if (normalizedPath.includes('/results/')) {
      containerName = 'results';
      const containerIndex = normalizedPath.indexOf('/results/');
      blobName = normalizedPath.substring(containerIndex + '/results/'.length);
    } else if (normalizedPath.includes('/models/')) {
      containerName = 'models';
      const containerIndex = normalizedPath.indexOf('/models/');
      blobName = normalizedPath.substring(containerIndex + '/models/'.length);
    } else {
      throw new Error(`Azure path must contain '/datasets/', '/results/', or '/models/'. Got: ${filePath}`);
    }
    
    return { containerName, blobName };
  }

  /**
   * Remove empty parent directories up to basePath
   * Used after moving directories to clean up empty folders
   * 
   * @param {string} dirPath - Path to start cleaning from (will clean parents)
   * @private
   */
  async _cleanupEmptyParents(dirPath) {
    try {
      let currentPath = path.dirname(dirPath);
      const basePathNormalized = path.normalize(this.basePath);

      // ✅ Walk up the directory tree, removing empty directories
      // Stop when we reach the basePath (don't delete datasets folder itself)
      while (currentPath !== basePathNormalized && currentPath.length > basePathNormalized.length) {
        try {
          // Check if directory is empty
          const entries = await fs.readdir(currentPath);
          
          if (entries.length === 0) {
            // Directory is empty, remove it
            await fs.rmdir(currentPath);
            console.log(`✅ Removed empty directory: ${currentPath}`);
            
            // Move up to parent directory
            currentPath = path.dirname(currentPath);
          } else {
            // Directory has contents, stop cleaning
            break;
          }
        } catch (error) {
          // If we can't read or remove, stop (might not exist or have permissions)
          if (error.code === 'ENOENT' || error.code === 'ENOTEMPTY') {
            break;
          }
          // For other errors, log and continue
          console.warn(`⚠️ Could not clean up ${currentPath}:`, error.message);
          break;
        }
      }
    } catch (error) {
      // Non-critical error, just log it
      console.warn(`⚠️ Error during cleanup of empty parents:`, error.message);
    }
  }

  /**
   * Helper: Recursively copy directory
   * @private
   */
  async _copyDirectoryRecursive(srcDir, destDir) {
    await this.ensureDir(destDir);
    const entries = await fs.readdir(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        await this._copyDirectoryRecursive(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Helper: Recursively remove directory
   * @private
   */
  async _removeDirectoryRecursive(dirPath) {
    // ✅ Use recursive option for rmdir (Node 12+)
    // This is simpler and handles nested directories automatically
    try {
      await fs.rmdir(dirPath, { recursive: true });
    } catch (error) {
      // Fallback: manual recursive deletion if rmdir fails
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await this._removeDirectoryRecursive(entryPath);
        } else {
          await fs.unlink(entryPath);
        }
      }

      await fs.rmdir(dirPath);
    }
  }

  /**
   * Delete a directory and all its contents (dataset folder).
   * Local: removes files from disk. Azure: deletes all blobs under the path prefix.
   * @param {string} dirPath - Full path to dataset root (e.g. .../datasets/company/project/version)
   * @returns {Promise<{ deleted: boolean, error?: string }>} deleted true if deleted or path did not exist; error set if deletion failed
   */
  async deleteDirectory(dirPath) {
    if (this.mode === 'local') {
      const { existsSync, rmSync } = require('fs');
      if (!existsSync(dirPath)) return { deleted: true };
      const maxRetries = 3;
      for (let i = 0; i < maxRetries; i++) {
        try {
          rmSync(dirPath, { recursive: true, force: true });
          return { deleted: true };
        } catch (err) {
          const isRetryable = (err.code === 'EPERM' || err.code === 'EBUSY') && i < maxRetries - 1;
          if (isRetryable) {
            await new Promise((r) => setTimeout(r, 500 * (i + 1)));
          } else {
            return { deleted: false, error: err.message };
          }
        }
      }
      return { deleted: false, error: 'Delete failed after retries' };
    }
    if (this.mode === 'azure') {
      try {
        const normalized = dirPath.replace(/\\/g, '/');
        const { containerName, blobName } = this._parseAzurePath(normalized);
        const prefix = blobName.endsWith('/') ? blobName : `${blobName}/`;
        const containerClient = this.blobServiceClient.getContainerClient(containerName);
        let deletedCount = 0;
        for await (const blob of containerClient.listBlobsFlat({ prefix })) {
          await containerClient.deleteBlob(blob.name);
          deletedCount++;
        }
        return { deleted: true };
      } catch (err) {
        return { deleted: false, error: err.message };
      }
    }
    return { deleted: false, error: `Unsupported storage mode: ${this.mode}` };
  }

  /**
   * Generate a signed URL for a file
   *
   * For local storage: Returns an API endpoint with token and expiration
   * For Azure: Returns a SAS URL (not yet fully implemented)
   * 
   * @param {string} filePath - File path (relative to dataset root or absolute)
   * @param {number} expiresInSeconds - URL expiration time in seconds (default: 3600 = 1 hour)
   * @param {Object} options - Additional options (datasetId for image serving route)
   * @returns {Promise<string>} Signed URL
   */
  async generateSignedUrl(filePath, expiresInSeconds = 3600, options = {}) {
    if (this.mode === 'local') {
      // ✅ Local mode: do NOT use signed URLs anymore.
      // We rely on auth/permission middleware and path validation only.
      // Return relative API URLs so the frontend can prepend its own base.
      // Encode file path for URL (relative to dataset root, e.g. images/train/...)
      const encodedPath = encodeURIComponent(filePath);

      // If datasetId is provided, use image serving route (for annotation images)
      if (options.datasetId) {
        // Auth is enforced via middleware; no signature/expiry query params needed.
        // Use the generic image endpoint (alias for legacy /image-signed).
        return `/api/dataset/${options.datasetId}/image?path=${encodedPath}`;
      }

      // Generic local URL (if needed) without signing
      return `/api/storage/file?path=${encodedPath}`;

    } else if (this.mode === 'azure') {
      // ✅ For Azure Blob Storage, generate SAS URL
      const { containerName, blobName } = this._parseAzurePath(filePath);
      const containerClient = this.blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      
      // Generate SAS token
      const sasOptions = {
        permissions: 'r', // Read only
        expiresOn: new Date(Date.now() + expiresInSeconds * 1000)
      };
      
      // Generate SAS URL
      const sasUrl = await blockBlobClient.generateSasUrl(sasOptions);
      return sasUrl;
    }
    
    throw new Error(`Unsupported storage mode: ${this.mode}`);
  }

}

// ✅ Export singleton instance
module.exports = new StorageAdapter(process.env.STORAGE_MODE || 'local');
