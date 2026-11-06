// Deleting a Cloudinary asset when only its delivery URL was stored.
//
// videoModel keeps `url` and `thumbnailUrl` but no `public_id`, and Cloudinary's destroy
// API needs the public_id - so it has to be recovered from the URL.
//
// A stored URL looks like:
//   https://res.cloudinary.com/<cloud>/video/upload/v1712345678/yteens_videos/abc123.mp4
// and the public_id is the part after the version, without the extension:
//   yteens_videos/abc123

const { cloudinary } = require('../config/cloudinary');

// Cloudinary transformation components look like `w_200,c_fill` or `q_auto`. They sit
// between the delivery type and the version, and are not part of the public_id.
const TRANSFORM_RE = /^[a-z]{1,3}_[^/]+$/;
const VERSION_RE = /^v\d+$/;
const SIGNATURE_RE = /^s--[A-Za-z0-9_-]+--$/;

const publicIdFromUrl = (url) => {
  if (!url || typeof url !== 'string') return null;

  let parts;
  try {
    parts = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }

  // .../<cloud>/<resource_type>/<delivery_type>/<rest...>
  const deliveryIndex = parts.findIndex((p) =>
    ['upload', 'authenticated', 'private'].includes(p)
  );
  if (deliveryIndex === -1) return null;

  let rest = parts.slice(deliveryIndex + 1);

  // Drop a signature, any transformations, and the version - whatever is left is the
  // public_id, which may itself contain slashes because of folders.
  if (rest.length && SIGNATURE_RE.test(rest[0])) rest = rest.slice(1);
  while (rest.length > 1 && TRANSFORM_RE.test(rest[0])) rest = rest.slice(1);
  if (rest.length && VERSION_RE.test(rest[0])) rest = rest.slice(1);
  if (!rest.length) return null;

  const joined = rest.join('/');
  const lastDot = joined.lastIndexOf('.');
  const lastSlash = joined.lastIndexOf('/');
  // Only strip a real extension, never a dot that belongs to a folder name.
  return lastDot > lastSlash ? joined.slice(0, lastDot) : joined;
};

// destroy() must be told the right resource_type or it silently reports 'not found' and
// deletes nothing. Read it from the URL rather than assuming, because this project mixes
// them: videos and their thumbnails both live under /video/ (thumbnails go through the
// video storage config, which is why their URLs end .jpg but they are video resources),
// while channel profile images go through imageStorage and live under /image/.
const resourceTypeFromUrl = (url) => {
  if (!url || typeof url !== 'string') return null;
  let parts;
  try {
    parts = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
  const found = parts.find((p) => ['image', 'video', 'raw'].includes(p));
  return found || null;
};

// Never throws. A failed delete must not stop the caller from finishing its own work -
// the asset becomes an orphan that needs reconciling, which is strictly better than
// leaving the database inconsistent as well.
const destroyCloudinaryAsset = async (url, label = 'asset') => {
  const publicId = publicIdFromUrl(url);
  const resourceType = resourceTypeFromUrl(url);

  if (!publicId || !resourceType) {
    if (url) console.warn(`[cloudinary] could not derive a public_id for ${label}: ${url}`);
    return { deleted: false, publicId: null, reason: 'no public_id' };
  }

  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      invalidate: true
    });
    // destroy() answers 'not found' rather than throwing when the asset is already gone,
    // which is fine - the end state is what was wanted either way.
    return { deleted: result.result === 'ok', publicId, resourceType, reason: result.result };
  } catch (err) {
    console.error(`[cloudinary] FAILED to destroy ${label} ${publicId}:`, err.message);
    return { deleted: false, publicId, resourceType, reason: err.message };
  }
};

module.exports = {
  publicIdFromUrl,
  resourceTypeFromUrl,
  destroyCloudinaryAsset,
  // Kept so the video delete route's existing import keeps working; it now derives the
  // resource type instead of hardcoding 'video', which is correct for both of its URLs.
  destroyVideoAsset: destroyCloudinaryAsset
};
