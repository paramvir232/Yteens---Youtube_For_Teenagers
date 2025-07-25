const mongoose = require('mongoose');
const express = require('express');
const app = express();
require('dotenv').config();
mongoose.connect(process.env.MONGODB_URI)
    .then(()=>console.log('Connected to MongoDB'))
    .catch(err=>console.log('Could Not Connect to MongoDB ..',err));