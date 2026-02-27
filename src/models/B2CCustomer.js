const mongoose = require("mongoose")
const bcrypt = require("bcrypt")

const b2cCustomerSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: false,
      default: null,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: false },
    phone: { type: String, required: true, trim: true },
    password: { type: String, required: true },
    partner: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", default: null },
    nationality: { type: String, default: "", trim: true },
    profileImage: { type: String, default: null }, // Added profileImage field to store the image path

    isEmailVerified: { type: Boolean, default: false },
    emailVerificationToken: { type: String, default: null },
    emailVerificationTokenExpires: { type: Date, default: null },
    emailVerificationOTP: { type: String, default: null },
    emailVerificationOTPExpires: { type: Date, default: null },

    resetPasswordOTP: { type: String, default: null },
    resetPasswordExpires: { type: Date, default: null },

    role: { type: String, enum: ["ROLE_B2C_USER"], default: "ROLE_B2C_USER" },

    lastLogin: { type: Date, default: null },

    whatsappNumber: { type: String, default: "", trim: true },
    status: { type: String, enum: ["Active", "Inactive", "Pending"], default: "Pending" },

    address: {
      street: { type: String, default: "" },
      city: { type: String, default: "" },
      country: { type: String, default: "" },
    },

    isDeleted: { type: Boolean, default: false },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
)

b2cCustomerSchema.index({ company: 1, email: 1 }, { sparse: true })
b2cCustomerSchema.index({ name: "text", whatsappNumber: "text", "address.street": "text" })
b2cCustomerSchema.index({ status: 1 })

b2cCustomerSchema.pre("save", async function (next) {
  // Only hash if password is new or modified
  if (!this.isModified("password")) {
    return next()
  }

  try {
    // Generate salt and hash password with 10 rounds
    const salt = await bcrypt.genSalt(10)
    this.password = await bcrypt.hash(this.password, salt)
    next()
  } catch (error) {
    next(error)
  }
})

b2cCustomerSchema.methods.comparePassword = async function (plainPassword) {
  try {
    return await bcrypt.compare(plainPassword, this.password)
  } catch (error) {
    throw error
  }
}

b2cCustomerSchema.methods.generateResetPasswordOTP = function () {
  const otp = Math.floor(100000 + Math.random() * 900000).toString()
  this.resetPasswordOTP = otp
  this.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000) // 15 minutes expiry
  return otp
}

b2cCustomerSchema.methods.verifyResetPasswordOTP = function (otp) {
  if (!this.resetPasswordOTP || !this.resetPasswordExpires) {
    return false
  }
  if (new Date() > this.resetPasswordExpires) {
    return false
  }
  return this.resetPasswordOTP === otp
}

module.exports = mongoose.model("B2CCustomer", b2cCustomerSchema)
