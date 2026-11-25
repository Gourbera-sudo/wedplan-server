import { collection } from "../config/db.js";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/error.js";

function boundedString(value, label, max, { required = false } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new ApiError(400, `${label} cannot be empty.`);
  if (text.length > max) throw new ApiError(400, `${label} is too long.`);
  return text;
}

/**
 * PATCH /api/profile — update the caller's own profile. Role, blocking and
 * subscription fields are deliberately NOT accepted here; those are admin-only
 * (see routes/admin.js), so a customer cannot self-promote.
 */
export async function updateProfile(req, res, next) {
  try {
    const { name, image, bio, phone, businessName } = req.body || {};
    const updates = { updatedAt: new Date() };

    if (name !== undefined) updates.name = boundedString(name, "Name", 100, { required: true });
    if (image !== undefined) {
      if (image === "") {
        updates.image = "";
      } else {
        const url = boundedString(image, "Profile image", 2048, { required: true });
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw new ApiError(400, "Profile image must be a valid URL.");
        }
        if (!["http:", "https:"].includes(parsed.protocol)) {
          throw new ApiError(400, "Profile image must be an http(s) URL.");
        }
        updates.image = url;
      }
    }
    if (bio !== undefined) updates.bio = boundedString(bio, "Bio", 1000);
    if (phone !== undefined) updates.phone = boundedString(phone, "Phone", 30);
    if (businessName !== undefined) {
      updates.businessName = boundedString(businessName, "Business name", 120);
    }

    const user = await collection("user").findOneAndUpdate(
      { _id: req.user._id },
      { $set: updates },
      { returnDocument: "after", projection: { password: 0 } },
    );
    if (!user) throw new ApiError(404, "Account no longer exists.");
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/profile/image — uploads a base64 image to ImgBB and returns the
 * hosted URL. Requires IMGBB_API_KEY; returns 503 with a clear message if the
 * key has not been added yet (per the env-only secrets rule).
 */
export async function uploadImage(req, res, next) {
  try {
    if (!env.imgbbApiKey) {
      throw new ApiError(
        503,
        "Image uploads are not configured yet (IMGBB_API_KEY missing in .env).",
      );
    }

    const { imageBase64 } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== "string") {
      throw new ApiError(400, "imageBase64 is required.");
    }

    // Accept raw base64 or a full image data URL, with real MIME/size checks.
    const dataUrl = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(imageBase64);
    const base64 = dataUrl ? dataUrl[2] : imageBase64;
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new ApiError(400, "Upload must contain valid base64 image data.");
    }
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length) throw new ApiError(400, "Image data is empty.");
    if (bytes.length > 4 * 1024 * 1024) {
      throw new ApiError(413, "Image must be smaller than 4 MB.");
    }
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isWebp =
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP";
    const isGif = bytes.subarray(0, 3).toString("ascii") === "GIF";
    if (!isPng && !isJpeg && !isWebp && !isGif) {
      throw new ApiError(400, "Only PNG, JPEG, WebP, or GIF images are supported.");
    }

    const form = new FormData();
    form.append("image", base64);

    const response = await fetch(
      `https://api.imgbb.com/1/upload?key=${env.imgbbApiKey}`,
      { method: "POST", body: form },
    );
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.success) {
      console.error("ImgBB upload failed:", data);
      throw new ApiError(502, "Image upload failed. Please try again.");
    }

    res.json({ url: data.data.url, displayUrl: data.data.display_url });
  } catch (err) {
    next(err);
  }
}
