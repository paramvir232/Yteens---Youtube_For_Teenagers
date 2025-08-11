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

// Storage configuration for videos (for other routes)
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'yteens_videos', // Folder for videos
    resource_type: 'video',  // Set for video uploads
    format: async (req, file) => 'mp4',  // Optional: force mp4 format for videos
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
