// config/cloudinary.js
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Storage configuration for profile images
const imageStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'yteens_uploads',
    resource_type: 'auto',
  },
})

/**
 * How long a single Cloudinary upload may take, in milliseconds.
 *
 * The SDK's own default is 60s (node_modules/cloudinary/lib/uploader.js: `post_request
 * .setTimeout(options.timeout != null ? options.timeout : 60000)`), which is fine for a
 * profile picture and far too short for a video from a phone.
 *
 * Measured: a 24.8MB clip picked on the device failed with `Error: Request Timeout`. The
 * bytes did reach Cloudinary - the asset was there, 24.8MB of it - but the handler had
 * already given up, so nothing was written to the database and nothing cleaned the asset
 * up. The user saw "Upload failed", and an unmoderated video stayed in the account.
 *
 * 10 minutes is chosen against the route's own ceiling rather than guessed: multer caps a
 * video at UPLOAD_MAX_BYTES, and 10 minutes clears that at a slow phone uplink with room
 * to spare. It bounds a stuck request rather than trying to be generous.
 */
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// Storage configuration for videos (for other routes)
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'yteens_videos', // Folder for videos
    resource_type: 'video',  // Set for video uploads
    format: async (req, file) => 'mp4',  // Optional: force mp4 format for videos
    timeout: UPLOAD_TIMEOUT_MS,
  },
});

// Storage for thumbnails
const thumbnailStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'yteens_thumbnails',
    resource_type: 'image',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    format: async () => 'jpg'
  }
});

module.exports = { cloudinary, storage, imageStorage,thumbnailStorage };
