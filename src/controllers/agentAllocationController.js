const createHttpError = require("http-errors")
const mongoose = require("mongoose")
const AvailabilityAgentAllocation = require("../models/AvailabilityAgentAllocation")
const { Trip } = require("../models/Trip")
const { TripAvailability } = require("../models/TripAvailability")
const Partner = require("../models/Partner")
const { Cabin } = require("../models/Cabin")

const buildActor = (user) => ({
  id: user?.id || null,
  name: user?.name || "Unknown",
  type: user?.layer || "system",
  layer: user?.layer,
})

// GET - List all agent allocations for a trip
exports.listAgentAllocations = async (req, res) => {
  try {
    const { companyId } = req
    const { tripId } = req.params
    const { page = 1, limit = 10 } = req.query

    const skip = (parseInt(page) - 1) * parseInt(limit)
    const limitNum = parseInt(limit)

    const query = {
      company: companyId,
      trip: tripId,
      isDeleted: false,
    }

    const [allocations, total] = await Promise.all([
      AvailabilityAgentAllocation.find(query)
        .populate("agent", "name code type")
        .populate("availability", "type cabins")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      AvailabilityAgentAllocation.countDocuments(query),
    ])

    res.status(200).json({
      success: true,
      message: "Agent allocations fetched successfully",
      data: allocations,
      pagination: {
        page: parseInt(page),
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    })
  } catch (error) {
    console.error("[v0] Error in listAgentAllocations:", error)
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    })
  }
}

// GET - Get specific agent allocation
exports.getAgentAllocationById = async (req, res) => {
  try {
    const { companyId } = req
    const { tripId, allocationId } = req.params

    const allocation = await AvailabilityAgentAllocation.findOne({
      _id: allocationId,
      company: companyId,
      trip: tripId,
      isDeleted: false,
    })
      .populate("agent", "name code type")
      .populate("availability", "type cabins")
      .populate("allocations.cabins.cabin", "name type")

    if (!allocation) {
      throw createHttpError(404, "Agent allocation not found")
    }

    res.status(200).json({
      success: true,
      message: "Agent allocation fetched successfully",
      data: allocation,
    })
  } catch (error) {
    console.error("[v0] Error in getAgentAllocationById:", error)
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    })
  }
}

// POST - Create agent allocation
exports.createAgentAllocation = async (req, res) => {
  try {
    const { companyId, user } = req
    const { tripId, availabilityId } = req.params
    const { agent, allocations } = req.body

    // Validate input
    if (!agent || !allocations || !Array.isArray(allocations) || allocations.length === 0) {
      throw createHttpError(400, "Agent ID and allocations array are required")
    }

    // Verify trip and availability exist
    const trip = await Trip.findOne({
      _id: tripId,
      company: companyId,
      isDeleted: false,
    })
    if (!trip) throw createHttpError(404, "Trip not found")

    // Verify agent exists and belongs to company
    const agentDoc = await Partner.findOne({
      _id: agent,
      company: companyId,
      status: "Active",
      isDeleted: false,
    })
    if (!agentDoc) throw createHttpError(404, "Agent not found or inactive")

    // Validate allocations
    const processedAllocations = []

    for (const allocationEntry of allocations) {
      const { type, cabins: cabinAllocations } = allocationEntry

      if (!type || !cabinAllocations || !Array.isArray(cabinAllocations)) {
        throw createHttpError(400, `Invalid allocation format. Each must have type and cabins array`)
      }

      // Fetch the correct availability for this allocation type
      const availability = await TripAvailability.findOne({
        trip: tripId,
        company: companyId,
        type: type, // Fetch availability matching the allocation type
        isDeleted: false,
      }).populate("cabins.cabin", "name type")
      
      if (!availability) {
        throw createHttpError(
          404,
          `No ${type} availability found for this trip`
        )
      }

      // Get available seats for this type in the trip's capacity details
      let availableInTrip = 0
      if (type === "passenger") {
        availableInTrip = trip.tripCapacityDetails.passenger.reduce(
          (sum, cap) => sum + cap.remainingSeat,
          0
        )
      } else if (type === "cargo") {
        availableInTrip = trip.tripCapacityDetails.cargo.reduce((sum, cap) => sum + cap.remainingSeat, 0)
      } else if (type === "vehicle") {
        availableInTrip = trip.tripCapacityDetails.vehicle.reduce(
          (sum, cap) => sum + cap.remainingSeat,
          0
        )
      }

      const processedCabins = []
      let totalAllocatedSeats = 0

      for (const cabinEntry of cabinAllocations) {
        const { cabin, allocatedSeats } = cabinEntry

        // Verify cabin exists and is of correct type
        const cabinDoc = await Cabin.findOne({
          _id: cabin,
          company: companyId,
          type,
          isDeleted: false,
        })
        if (!cabinDoc) {
          throw createHttpError(404, `Cabin not found or type mismatch for cabin ID: ${cabin}`)
        }

        const seatsNum = parseInt(allocatedSeats)
        if (isNaN(seatsNum) || seatsNum < 0) {
          throw createHttpError(400, `Allocated seats must be a non-negative number for cabin ${cabinDoc.name}`)
        }

        // Validate against availability cabins
        const availabilityCabin = availability.cabins.find(c => {
          const cabinId = c.cabin && c.cabin._id ? c.cabin._id.toString() : (c.cabin ? c.cabin.toString() : null)
          const requestCabinId = cabin.toString()
          return cabinId === requestCabinId
        })
        if (!availabilityCabin) {
          console.log("[v0] Cabin lookup failed. Available cabins:", availability.cabins.map(c => ({
            cabinId: c.cabin._id ? c.cabin._id.toString() : c.cabin.toString(),
            cabinName: c.cabin.name
          })))
          console.log("[v0] Requested cabin:", cabin.toString())
          throw createHttpError(
            400,
            `Cabin ${cabinDoc.name} is not available in this availability for allocation`
          )
        }

        if (seatsNum > availabilityCabin.seats - availabilityCabin.allocatedSeats) {
          throw createHttpError(
            400,
            `Cannot allocate ${seatsNum} seats to cabin ${cabinDoc.name}. Only ${availabilityCabin.seats - availabilityCabin.allocatedSeats} seats available.`
          )
        }

        totalAllocatedSeats += seatsNum
        processedCabins.push({
          cabin,
          allocatedSeats: seatsNum,
        })
      }

      if (totalAllocatedSeats > availableInTrip) {
        throw createHttpError(
          400,
          `Cannot allocate ${totalAllocatedSeats} total ${type} seats to agent. Only ${availableInTrip} seats available in trip.`
        )
      }

      processedAllocations.push({
        type,
        cabins: processedCabins,
        totalAllocatedSeats,
      })
    }

    // Create separate agent allocations for each availability type
    const createdAllocations = []
    
    // Group allocations by availability ID to get the right availability for updates
    const allocationsByAvailability = {}
    
    for (const allocation of processedAllocations) {
      // Fetch availability again for updates (we need the fresh reference for each type)
      const availability = await TripAvailability.findOne({
        trip: tripId,
        company: companyId,
        type: allocation.type,
        isDeleted: false,
      }).populate("cabins.cabin", "name type")
      
      if (!availability) continue // Already validated above
      
      // Create agent allocation for this type
      const allocationData = {
        company: companyId,
        trip: tripId,
        availability: availability._id,
        agent,
        allocations: [allocation], // Single allocation object for this type
        createdBy: buildActor(user),
      }

      const newAllocation = new AvailabilityAgentAllocation(allocationData)
      await newAllocation.save()
      createdAllocations.push(newAllocation)

      // Update availability cabins with allocated seats
      // Agent allocations reduce public available seats but DO NOT reduce trip operational capacity
      for (const cabin of allocation.cabins) {
        const availabilityCabin = availability.cabins.find(c => c.cabin.toString() === cabin.cabin.toString())
        if (availabilityCabin) {
          availabilityCabin.allocatedSeats += cabin.allocatedSeats
        }
      }
      
      // Save the updated availability for this type
      await availability.save()
    }

    // Populate created allocations with details
    const populatedAllocations = await Promise.all(
      createdAllocations.map(allocation =>
        AvailabilityAgentAllocation.findById(allocation._id)
          .populate("agent", "name code type")
          .populate("availability", "type cabins")
          .populate("allocations.cabins.cabin", "name type")
      )
    )

    // Build response with all created allocations
    const responseData = populatedAllocations.map(allocation => {
      const availability = allocation.availability
      const availabilitySummary = availability.cabins.map(cabin => ({
        cabin: cabin.cabin,
        cabinName: cabin.cabin.name,
        cabinType: cabin.cabin.type,
        totalSeats: cabin.seats,
        allocatedSeats: cabin.allocatedSeats,
        remainingSeats: cabin.seats - cabin.allocatedSeats,
      }))

      return {
        allocation,
        availabilitySummary: {
          type: availability.type,
          cabins: availabilitySummary,
        },
      }
    })

    res.status(201).json({
      success: true,
      message: "Agent allocations created successfully",
      data: {
        allocations: responseData,
      },
    })
  } catch (error) {
    console.error("[v0] Error in createAgentAllocation:", error)
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    })
  }
}

// PUT - Update agent allocation
exports.updateAgentAllocation = async (req, res) => {
  try {
    const { companyId, user } = req
    const { tripId, allocationId } = req.params
    const { allocations } = req.body

    if (!allocations || !Array.isArray(allocations)) {
      throw createHttpError(400, "Allocations array is required")
    }

    const allocation = await AvailabilityAgentAllocation.findOne({
      _id: allocationId,
      company: companyId,
      trip: tripId,
      isDeleted: false,
    })
    if (!allocation) throw createHttpError(404, "Agent allocation not found")

    const availability = await TripAvailability.findById(allocation.availability)
    if (!availability) throw createHttpError(404, "Availability not found")

    const trip = await Trip.findById(tripId)
    if (!trip) throw createHttpError(404, "Trip not found")

    // Restore previous allocations from availability (agent allocations only affect availability, not trip capacity)
    for (const prevAllocation of allocation.allocations) {
      for (const cabin of prevAllocation.cabins) {
        const availabilityCabin = availability.cabins.find(c => c.cabin.toString() === cabin.cabin.toString())
        if (availabilityCabin) {
          availabilityCabin.allocatedSeats -= cabin.allocatedSeats
        }
      }
    }

    // Validate new allocations
    const processedAllocations = []

    for (const allocationEntry of allocations) {
      const { type, cabins: cabinAllocations } = allocationEntry

      if (!type || !cabinAllocations || !Array.isArray(cabinAllocations)) {
        throw createHttpError(400, `Invalid allocation format`)
      }

      const processedCabins = []
      let totalAllocatedSeats = 0

      for (const cabinEntry of cabinAllocations) {
        const { cabin, allocatedSeats } = cabinEntry

        const cabinDoc = await Cabin.findOne({
          _id: cabin,
          company: companyId,
          type,
          isDeleted: false,
        })
        if (!cabinDoc) {
          throw createHttpError(404, `Cabin not found for ID: ${cabin}`)
        }

        const seatsNum = parseInt(allocatedSeats)
        if (isNaN(seatsNum) || seatsNum < 0) {
          throw createHttpError(400, `Allocated seats must be non-negative`)
        }

        const availabilityCabin = availability.cabins.find(c => c.cabin.toString() === cabin.toString())
        if (!availabilityCabin) {
          throw createHttpError(400, `Cabin not available in this availability`)
        }

        if (seatsNum > availabilityCabin.seats - availabilityCabin.allocatedSeats) {
          throw createHttpError(
            400,
            `Cannot allocate ${seatsNum} seats. Only ${availabilityCabin.seats - availabilityCabin.allocatedSeats} available.`
          )
        }

        totalAllocatedSeats += seatsNum
        processedCabins.push({
          cabin,
          allocatedSeats: seatsNum,
        })
      }

      processedAllocations.push({
        type,
        cabins: processedCabins,
        totalAllocatedSeats,
      })
    }

    // Update with new allocations
    allocation.allocations = processedAllocations
    allocation.updatedBy = buildActor(user)
    await allocation.save()

    // Apply new allocations to availability (agent allocations only affect availability, not trip capacity)
    for (const newAllocation of processedAllocations) {
      for (const cabin of newAllocation.cabins) {
        const availabilityCabin = availability.cabins.find(c => c.cabin.toString() === cabin.cabin.toString())
        if (availabilityCabin) {
          availabilityCabin.allocatedSeats += cabin.allocatedSeats
        }
      }
    }
    await availability.save()

    const updated = await AvailabilityAgentAllocation.findById(allocationId)
      .populate("agent", "name code type")
      .populate("availability", "type cabins")
      .populate("allocations.cabins.cabin", "name type")

    // Build availability summary with remaining seats
    const availabilitySummary = availability.cabins.map(cabin => ({
      cabin: cabin.cabin,
      cabinName: cabin.cabin.name,
      cabinType: cabin.cabin.type,
      totalSeats: cabin.seats,
      allocatedSeats: cabin.allocatedSeats,
      remainingSeats: cabin.seats - cabin.allocatedSeats,
    }))

    res.status(200).json({
      success: true,
      message: "Agent allocation updated successfully",
      data: {
        allocation: updated,
        availabilitySummary: {
          type: availability.type,
          cabins: availabilitySummary,
        },
      },
    })
  } catch (error) {
    console.error("[v0] Error in updateAgentAllocation:", error)
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    })
  }
}

// DELETE - Delete agent allocation
exports.deleteAgentAllocation = async (req, res) => {
  try {
    const { companyId, user } = req
    const { tripId, allocationId } = req.params

    const allocation = await AvailabilityAgentAllocation.findOne({
      _id: allocationId,
      company: companyId,
      trip: tripId,
      isDeleted: false,
    })
    if (!allocation) throw createHttpError(404, "Agent allocation not found")

    const availability = await TripAvailability.findById(allocation.availability)
    if (!availability) throw createHttpError(404, "Availability not found")

    const trip = await Trip.findById(tripId)
    if (!trip) throw createHttpError(404, "Trip not found")

    // Restore allocation seats back to availability
    // Agent allocations do NOT affect trip operational capacity, only restore available seats
    for (const allocationEntry of allocation.allocations) {
      for (const cabin of allocationEntry.cabins) {
        const availabilityCabin = availability.cabins.find(c => c.cabin.toString() === cabin.cabin.toString())
        if (availabilityCabin) {
          availabilityCabin.allocatedSeats -= cabin.allocatedSeats
        }
      }
    }
    await availability.save()

    allocation.isDeleted = true
    allocation.updatedBy = buildActor(user)
    await allocation.save()

    // Build availability summary with restored seats
    const availabilitySummary = availability.cabins.map(cabin => ({
      cabin: cabin.cabin,
      cabinName: cabin.cabin.name || 'N/A',
      cabinType: cabin.cabin.type || 'N/A',
      totalSeats: cabin.seats,
      allocatedSeats: cabin.allocatedSeats,
      remainingSeats: cabin.seats - cabin.allocatedSeats,
    }))

    res.status(200).json({
      success: true,
      message: "Agent allocation deleted successfully",
      data: {
        availabilitySummary: {
          type: availability.type,
          cabins: availabilitySummary,
        },
      },
    })
  } catch (error) {
    console.error("[v0] Error in deleteAgentAllocation:", error)
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    })
  }
}

// GET - Get total availability summary for allocation
exports.getAvailabilityForAllocation = async (req, res) => {
  try {
    const { companyId } = req
    const { tripId, availabilityId } = req.params

    const availability = await TripAvailability.findOne({
      _id: availabilityId,
      company: companyId,
      trip: tripId,
      isDeleted: false,
    }).populate("cabins.cabin", "name type")

    if (!availability) throw createHttpError(404, "Availability not found")

    const trip = await Trip.findById(tripId).select("tripCapacityDetails")
    if (!trip) throw createHttpError(404, "Trip not found")

    // Calculate available seats per cabin
    const availableSummary = {
      passenger: [],
      cargo: [],
      vehicle: [],
    }

    if (availability.type === "passenger") {
      availability.cabins.forEach(cabin => {
        const available = cabin.seats - cabin.allocatedSeats
        availableSummary.passenger.push({
          cabin: cabin.cabin,
          totalSeats: cabin.seats,
          allocatedSeats: cabin.allocatedSeats,
          availableSeats: available,
        })
      })
    } else if (availability.type === "cargo") {
      availability.cabins.forEach(cabin => {
        const available = cabin.seats - cabin.allocatedSeats
        availableSummary.cargo.push({
          cabin: cabin.cabin,
          totalSeats: cabin.seats,
          allocatedSeats: cabin.allocatedSeats,
          availableSeats: available,
        })
      })
    } else if (availability.type === "vehicle") {
      availability.cabins.forEach(cabin => {
        const available = cabin.seats - cabin.allocatedSeats
        availableSummary.vehicle.push({
          cabin: cabin.cabin,
          totalSeats: cabin.seats,
          allocatedSeats: cabin.allocatedSeats,
          availableSeats: available,
        })
      })
    }

    res.status(200).json({
      success: true,
      message: "Availability summary for allocation fetched successfully",
      data: {
        availabilityId,
        availabilityType: availability.type,
        totalSummary: availableSummary,
        tripCapacityDetails: trip.tripCapacityDetails,
      },
    })
  } catch (error) {
    console.error("[v0] Error in getAvailabilityForAllocation:", error)
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    })
  }
}
