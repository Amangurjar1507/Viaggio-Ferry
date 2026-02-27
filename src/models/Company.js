const mongoose = require("mongoose")
const bcrypt = require("bcryptjs")
const crypto = require("crypto")

const CompanySchema = new mongoose.Schema(
  {
    // Basic Company Information
    companyName: { type: String, required: true, trim: true },
    registrationNumber: { type: String, trim: true },
    taxVatNumber: { type: String, trim: true }, // ✅ Tax/VAT Number
    logoUrl: { type: String },
    dateEstablished: { type: Date },

    // Contact Details
    address: { type: String },
    city: { type: String },
    country: { type: String },
    postalCode: { type: String },
    mainPhoneNumber: { type: String },
    emailAddress: { type: String, required: true },
    website: { type: String },

    // Operational Details
    defaultCurrency: { type: String, default: "USD" },
    applicableTaxes: [{ type: String }], // ✅ Applicable Taxes (e.g. ["VAT", "Excise"])
    operatingPorts: [{ type: String }],
    operatingCountries: [{ type: String }], // ✅ Operating Countries
    timeZone: { type: String }, // ✅ Time Zone
    workingHours: { type: String },

    // About Us
    whoWeAre: { type: String },
    whoWeAreImage: { type: String }, // Add whoWeAreImage field to store image for Who We Are
    vision: { type: String },
    mission: { type: String },
    purpose: { type: String },
    companySlug: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true,
    },

    adminProfileImage: { type: String },

    // Social Network Links
    facebookUrl: { type: String },
    instagramUrl: { type: String },
    whatsappNumber: { type: String },
    linkedinProfile: { type: String },
    skypeId: { type: String },

    // Authentication / Status
    loginEmail: { type: String, required: true, unique: true, lowercase: true, trim: true, index: false },
    passwordHash: { type: String, required: true },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false }, // Added isDeleted field to support soft deletes
    verifiedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    rejectionReason: { type: String },

    verificationToken: { type: String },
    verificationTokenExpires: { type: Date },
    verificationPending: { type: Boolean, default: false }, // Flag to track if verification link was sent

    resetPasswordOTP: {
      type: String,
      default: null,
    },
    resetPasswordExpires: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
)

// Indexes for query optimization
CompanySchema.index({ companyName: 1 })
CompanySchema.index({ status: 1 })

async function generateRegistrationNumber() {
  const lastCompany = await mongoose
    .model("Company")
    .findOne({
      registrationNumber: { $regex: /^REG-\d+$/ },
    })
    .sort({ createdAt: -1 })

  if (!lastCompany || !lastCompany.registrationNumber) {
    return "REG-1001"
  }

  const lastNumber = Number.parseInt(lastCompany.registrationNumber.split("-")[1], 10)

  if (isNaN(lastNumber)) {
    return "REG-1001"
  }

  const nextNumber = lastNumber + 1

  return `REG-${nextNumber}`
}

// Hash password before saving
CompanySchema.pre("save", async function (next) {
  if (!this.registrationNumber) {
    this.registrationNumber = await generateRegistrationNumber()
  }

  if (this.isModified("passwordHash")) {
    const salt = await bcrypt.genSalt(10)
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt)
  }

  next()
})

// Method to compare passwords
CompanySchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.passwordHash)
}

CompanySchema.methods.generateResetPasswordOTP = function () {
  // Generate a 6-digit OTP
  const otp = crypto.randomInt(100000, 999999).toString()

  // Hash the OTP before saving
  this.resetPasswordOTP = crypto.createHash("sha256").update(otp).digest("hex")

  // Set expiry to 15 minutes from now
  this.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000)

  // Return plain OTP to send via email
  return otp
}

CompanySchema.methods.verifyResetPasswordOTP = function (otp) {
  if (!this.resetPasswordOTP || !this.resetPasswordExpires) {
    return false
  }

  // Check if OTP has expired
  if (this.resetPasswordExpires < new Date()) {
    return false
  }

  // Hash the provided OTP and compare with stored hash
  const hashedOTP = crypto.createHash("sha256").update(otp).digest("hex")
  return hashedOTP === this.resetPasswordOTP
}

module.exports = mongoose.model("Company", CompanySchema)
