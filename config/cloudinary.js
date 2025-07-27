const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'yteens_videos', // Folder name in Cloudinary
    resource_type: 'video',  // Very important: tells Cloudinary to expect videos
    format: async (req, file) => 'mp4' // optional: force mp4
  },
});

module.exports = {
  cloudinary,
  storage
};
