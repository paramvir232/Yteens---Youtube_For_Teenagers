const express = require('express');
const router = express.Router();
const User = require('../models/usersModel');
const catchAsync = require('../util/catchError');
const bcrypt = require('bcrypt');
const { signupSchema,loginSchema } = require('../validators/userValidator');
const joiValidate = require('../middleware/joiValidationMW')

// Signup
router.post('/signup', joiValidate(signupSchema), catchAsync(async (req, res) => {
 
  const { name, email, password, age } = req.body;

  const existing = await User.findOne({ email });
  if (existing) return res.status(409).json({ msg: 'User already exists' });

  const user = new User({
    userName: name,
    email,
    password,
    age
  });

  await user.save();
  res.status(201).json({ msg: 'Signup successful', user: { id: user._id, name: user.userName } });
}));

// Login
router.post('/login', joiValidate(loginSchema) , catchAsync(async (req, res) => {

  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ msg: 'User not found' });

  const isMatch = await user.comparePassword(password);
  if (!isMatch) return res.status(401).json({ msg: 'Invalid password' });

  res.status(200).json({ msg: 'Login successful', user: { id: user._id, name: user.userName } });
}));

// Get all users
router.get('/', catchAsync(async (req, res) => {
  const users = await User.find().select('-password');
  res.status(200).json(users);
}));

// Get one user by ID
router.get('/getDetail/:id', catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id).select('-password');
  if (!user) return res.status(404).json({ msg: 'User not found' });
  res.status(200).json(user);
}));

// Update user
router.put('/update/:id', catchAsync(async (req, res) => {
  const updates = req.body;
  if (updates.password) {
    const salt = await bcrypt.genSalt(10);
    updates.password = await bcrypt.hash(updates.password, salt);
  }

  const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true });
  res.status(200).json({ msg: 'User updated', user });
}));

// Delete user
router.delete('/delete/:id', catchAsync(async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.status(200).json({ msg: 'User deleted' });
}));

module.exports = router;
