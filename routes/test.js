const express = require('express');
const router = express.Router();
const multer = require('multer');
const { storage } = require('../config/cloudinary');
const upload = multer({ storage });

const catchAsync = require('../util/catchError');

// ✅ Upload a video file to Cloudinary
router.post('/upload', upload.single('video'), catchAsync(async (req, res) => {
  if (!req.file || !req.file.path) {
    return res.status(400).json({ msg: 'No video uploaded' });
  }

  // req.file.path is the Cloudinary URL
  res.status(201).json({
    msg: 'Video uploaded successfully',
    videoUrl: req.file.path
  });
}));

module.exports = router;

