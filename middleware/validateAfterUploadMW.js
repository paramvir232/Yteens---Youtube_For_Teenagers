const { destroyCloudinaryAsset } = require('../util/cloudinaryAsset');

const validateAfterUpload = (schema) => {
  return async (req, res, next) => {
    const { error } = schema.validate(req.body ?? {});
    if (!error) return next();

    // .fields() puts them in req.files as { field: [file] }; .single() uses req.file.
    const uploaded = [
      ...Object.values(req.files || {}).flat(),
      ...(req.file ? [req.file] : [])
    ].filter((file) => file && file.path);

    for (const file of uploaded) {
      const result = await destroyCloudinaryAsset(file.path, file.fieldname || 'upload');
      if (!result.deleted) {
        console.warn(
          `[validateAfterUpload] rejected request left ${file.fieldname} behind ` +
          `(${result.reason}) - public_id ${result.publicId}`
        );
      }
    }

    if (uploaded.length) {
      console.log(
        `[validateAfterUpload] rejected (${error.details[0].message}); ` +
        `cleaned up ${uploaded.length} Cloudinary asset(s)`
      );
    }

    return res.status(400).json({ msg: error.details[0].message });
  };
};

module.exports = validateAfterUpload;
