const mongoose = require("mongoose")
const { LEDGER_TYPES, LEDGER_TYPE_MAPPING } = require("../constants/ledgerTypes")

const STATUS = ["Active", "Inactive"]

/**
 * SuperAdminLedger Schema
 *
 * Purpose: Defines the BASE Chart of Accounts for the entire platform
 * - Created ONLY by SUPERADMIN
 * - No company field (platform-wide)
 * - Always locked and systemAccount = true
 * - Serves as template for CompanyLedger
 * - Cannot be deleted (soft delete only)
 *
 * This ensures accounting structure consistency across all tenants
 */
const SuperAdminLedgerSchema = new mongoose.Schema(
  {
    ledgerCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      match: /^\d{2}-\d{5}$/,
      index: false,
    },
    ledgerSequenceNumber: {
      type: Number,
      required: true,
      default: 0,
    },
    ledgerDescription: {
      type: String,
      required: false,
      trim: true,
      maxlength: 500,
      index: true,
    },
    ledgerType: {
      type: String,
      enum: LEDGER_TYPES,
      required: true,
      index: true,
    },
    typeSequence: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: STATUS,
      default: "Active",
      index: true,
    },
    // These fields are ALWAYS true for SuperAdminLedger
    systemAccount: {
      type: Boolean,
      default: true,
      required: true,
      immutable: true,
    },
    locked: {
      type: Boolean,
      default: true,
      required: true,
      immutable: true,
    },
    createdBy: {
      type: String,
      enum: ["super_admin"],
      default: "super_admin",
      required: true,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
      maxlength: 2000,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: "superadminledgers",
  },
)

// Indexes for query optimization
SuperAdminLedgerSchema.index({ ledgerType: 1, status: 1 })
SuperAdminLedgerSchema.index({ ledgerDescription: "text", ledgerCode: "text" })

// Prevent modification of system fields
SuperAdminLedgerSchema.pre("save", function (next) {
  if (!this.isNew) {
    this.systemAccount = true
    this.locked = true
    this.createdBy = "super_admin"
  }
  next()
})

module.exports = {
  SuperAdminLedger: mongoose.model("SuperAdminLedger", SuperAdminLedgerSchema),
  SUPERADMIN_LEDGER_STATUS: STATUS,
}
