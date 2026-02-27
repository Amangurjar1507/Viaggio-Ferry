const mongoose = require("mongoose")

const TermsAndConditionsSchema = new mongoose.Schema(
  {
    // Company Reference
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      unique: true, // Each company has one T&C document
    },

    // Content
    content: {
      type: String,
      default: "",
      // Rich text/HTML content from CKEditor
    },

    // Status Management
    status: {
      type: String,
      enum: ["draft", "published"],
      default: "draft",
    },

    // Version Control
    version: {
      type: Number,
      default: 1,
    },

    // Publishing Info
    publishedAt: {
      type: Date,
      default: null,
    },

    publishedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // Admin user who published
      default: null,
    },

    // Draft Saved Info
    draftSavedAt: {
      type: Date,
      default: null,
    },

    // Metadata
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
)

// Index for query optimization
TermsAndConditionsSchema.index({ status: 1 })

module.exports = mongoose.model("TermsAndConditions", TermsAndConditionsSchema)
