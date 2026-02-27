# Trip-Related Data Flow Analysis

## Overview
This document provides a comprehensive analysis of how trip-related data flows through the Ferry Trips API system. It covers the lifecycle of trips from creation through completion, including availability tracking, bookings, and agent allocations.

---

## 1. Core Trip Lifecycle

### 1.1 Trip Creation Flow

```
POST /api/trips (Trip Controller)
    ↓
    ├─→ Validate Authentication & Authorization
    │   ├─ verifyToken()
    │   ├─ extractCompanyId()
    │   └─ checkPermission("ship-trips", "trips", "write")
    ├─→ Validate Input
    │   ├─ Required fields: tripName, tripCode, ship, departurePort, arrivalPort, dates
    │   ├─ Date validation: departure < arrival
    │   ├─ ObjectId validation for ship, ports, promotion
    │   └─ Unique constraint: tripCode per company
    ├─→ Verify Related Entities
    │   ├─ Ship exists, belongs to company, isDeleted=false
    │   ├─ Departure Port exists, isDeleted=false
    │   ├─ Arrival Port exists, isDeleted=false
    │   └─ Promotion exists if provided (optional)
    ├─→ Extract Ship Capacity Data
    │   ├─ Passenger Capacity: cabins with seat counts
    │   ├─ Cargo Capacity: cabins with spot counts
    │   └─ Vehicle Capacity: cabins with spot counts
    ├─→ Build Trip Document
    │   ├─ Create tripCapacityDetails object
    │   │   ├─ passenger: [{cabinId, cabinName, totalSeat, remainingSeat}]
    │   │   ├─ cargo: [{cabinId, cabinName, totalSeat, remainingSeat}]
    │   │   └─ vehicle: [{cabinId, cabinName, totalSeat, remainingSeat}]
    │   ├─ Set aggregate remaining seats:
    │   │   ├─ remainingPassengerSeats
    │   │   ├─ remainingCargoSeats
    │   │   └─ remainingVehicleSeats
    │   ├─ Status: SCHEDULED, ONGOING, COMPLETED
    │   └─ Set createdBy {id, name, type, layer}
    ├─→ Save Trip to Database
    │   └─ Trip document indexed by: company, tripCode, departureDateTime, ship, ports, status
    └─→ Return Created Trip
        └─ Populate: ship, departurePort, arrivalPort, promotion
```

### 1.2 Trip Status Progression

```
SCHEDULED → ONGOING → COMPLETED
    ↓          ↓           ↓
  • Booking   • Check-in   • Trip Report
  • Allocation• Boarding   • Verified
             • Cargo ops
```

---

## 2. Trip Capacity Management

### 2.1 Capacity Structure (Per Trip)

```
Trip Document Structure:
└─ tripCapacityDetails {
    passenger: [
      {
        cabinId: ObjectId,
        cabinName: "Economy",
        totalSeat: 100,
        remainingSeat: 95  ← Updated as bookings are made
      }
    ],
    cargo: [
      {
        cabinId: ObjectId,
        cabinName: "Cargo Hold",
        totalSeat: 50,
        remainingSeat: 45
      }
    ],
    vehicle: [
      {
        cabinId: ObjectId,
        cabinName: "Vehicle Deck",
        totalSeat: 30,
        remainingSeat: 28
      }
    ]
  }

Aggregate Totals (Quick Access):
├─ remainingPassengerSeats: 95
├─ remainingCargoSeats: 45
└─ remainingVehicleSeats: 28
```

### 2.2 Capacity Updates

Capacity is decremented when:
1. **Passenger Booking Created** → remainingPassengerSeats decremented
2. **Cargo Booking Created** → remainingCargoSeats decremented
3. **Vehicle Booking Created** → remainingVehicleSeats decremented
4. **Booking Cancelled** → Capacity restored

---

## 3. Trip Availability System

### 3.1 TripAvailability Model

```
TripAvailability Document (Per Cabin, Per Type):
├─ company: ObjectId (Company)
├─ trip: ObjectId (Trip)
├─ type: String (passenger | cargo | vehicle)
├─ cabins: [
│   {
│     cabin: ObjectId,
│     seats: 100,              ← Total capacity
│     allocatedSeats: 5,       ← Allocated to partners
│     _id: false
│   }
  ]
├─ allocatedAgent: ObjectId (Partner) - optional
├─ createdBy: {id, name, type, layer}
├─ updatedBy: {id, name, type, layer}
└─ isDeleted: Boolean
```

### 3.2 Availability vs Booking Relationship

```
TripAvailability Purpose:
  • Tracks TOTAL capacity per cabin, per availability type
  • Tracks allocations to AGENTS (partners)
  • Different from Booking which tracks CUSTOMER purchases

Flow:
  Trip Created
    ↓
    └─→ Auto-generate TripAvailability Records
        ├─ For each passenger cabin: create TripAvailability (passenger)
        ├─ For each cargo cabin: create TripAvailability (cargo)
        └─ For each vehicle cabin: create TripAvailability (vehicle)
```

---

## 4. Agent Allocation System

### 4.1 AvailabilityAgentAllocation Model

```
AvailabilityAgentAllocation Document:
├─ company: ObjectId
├─ trip: ObjectId
├─ availability: ObjectId (TripAvailability)
├─ agent: ObjectId (Partner)
├─ allocations: [
│   {
│     type: "passenger" | "cargo" | "vehicle",
│     cabins: [
│       {
│         cabin: ObjectId,
│         allocatedSeats: 20,
│         _id: false
│       }
│     ],
│     totalAllocatedSeats: 20,
│     _id: false
│   }
  ]
├─ createdBy: {id, name, type, layer}
└─ updatedBy: {id, name, type, layer}
```

### 4.2 Agent Allocation Flow

```
allocateToAgent(tripId, agentId, availabilityId, quantities)
    ↓
    ├─→ Validate agent exists
    ├─→ Validate availability exists
    ├─→ Check capacity: allocations + bookings ≤ totalCapacity
    ├─→ Create AvailabilityAgentAllocation
    │   └─ Link agent to specific availability
    ├─→ Update TripAvailability.allocatedAgent
    └─→ Return allocation confirmation
```

---

## 5. Passenger Booking Flow

### 5.1 Booking Lifecycle

```
POST /api/bookings (Passenger Booking Controller)
    ↓
    ├─→ Validate Authentication
    ├─→ Generate bookingReference (unique)
    ├─→ Validate Trip
    │   ├─ outboundTrip exists and is SCHEDULED/ONGOING
    │   └─ returnTrip exists if bookingType=Return
    ├─→ Validate Passenger Data
    │   ├─ Passenger array not empty
    │   ├─ Each passenger has: name, type (Adult/Child/Infant)
    │   └─ Count passengers by type: adultsCount, childrenCount, infantsCount
    ├─→ Validate Capacity
    │   ├─ remainingPassengerSeats ≥ passengerCount
    │   ├─ Cabin availability for the selected cabin
    │   └─ Check per-cabin remainingSeat in tripCapacityDetails
    ├─→ Price Calculation
    │   ├─ Fetch PriceList for trip route
    │   ├─ baseFare = fare per passenger type × count
    │   ├─ Apply taxes (from Tax model)
    │   ├─ Apply discount/promotion (from Promotion)
    │   └─ totalFare = baseFare + taxes - discount
    ├─→ Create PassengerBooking
    │   ├─ bookingStatus: Pending (awaiting payment)
    │   ├─ paymentStatus: Pending
    │   ├─ paymentMethod: null (set on payment)
    │   ├─ bookingAgent: Partner ID (if B2B)
    │   ├─ b2cCustomer: Customer ID (if B2C)
    │   └─ bookingSource: Agent | B2C | Internal | Partner
    ├─→ Decrement Trip Capacity
    │   ├─ remainingPassengerSeats -= passengerCount
    │   ├─ Update tripCapacityDetails[cabin].remainingSeat
    │   └─ Save Trip document
    └─→ Return Booking with bookingReference
        ├─ Status: Pending
        └─ Payment: Required
```

### 5.2 Booking Status Progression

```
Pending → Confirmed → CheckedIn → Boarded → Completed
   ↓          ↓           ↓          ↓          ↓
Payment    Deposit    Pre-Trip   Boarding   Post-Trip
Pending    Confirmed  Validation Validation Records

Alternative Path:
Any Status → Cancelled
   ↓
Capacity Restored
```

### 5.3 Capacity Update on Booking Cancellation

```
DELETE /api/bookings/:id (Cancel Booking)
    ↓
    ├─→ Validate booking status allows cancellation
    ├─→ Fetch Trip
    ├─→ Restore Capacity
    │   ├─ remainingPassengerSeats += passengerCount
    │   ├─ Update tripCapacityDetails[cabin].remainingSeat
    │   └─ Save Trip
    ├─→ Update booking: bookingStatus = Cancelled
    │   └─ Set cancellationDateTime and cancellationReason
    └─→ Return cancellation confirmation
```

---

## 6. Cargo and Vehicle Booking Flows

### 6.1 Cargo Booking

```
Similar to Passenger Booking:
POST /api/cargo-bookings
    ├─→ Validate cargoBookingType (Standard/Hazardous/Refrigerated/etc)
    ├─→ Check remainingCargoSeats in trip
    ├─→ Validate cargo weight & dimensions
    ├─→ Calculate cargo pricing (weight-based, per ton)
    ├─→ Create CargoBooking
    └─→ Decrement remainingCargoSeats

Key Differences:
• CargoBooking tracks: weight, dimensions, special handling
• Pricing: based on weight/volume, not passenger type
• Tracking: shipment tracking number
```

### 6.2 Vehicle Booking

```
Similar Pattern:
POST /api/vehicle-bookings
    ├─→ Validate vehicleType (Car/SUV/Truck/etc)
    ├─→ Check remainingVehicleSeats in trip
    ├─→ Validate vehicle dimensions fit cabin
    ├─→ Calculate vehicle pricing (per vehicle or per length)
    ├─→ Create VehicleBooking
    └─→ Decrement remainingVehicleSeats

Key Differences:
• VehicleBooking tracks: vehicleType, dimensions, driver info
• Parking assignment: specific parking spot
• Tracking: vehicle tracking during voyage
```

---

## 7. Trip Availability Retrieval

### 7.1 Get Availability Endpoint

```
GET /api/trips/:tripId/availability
    ↓
    ├─→ Fetch Trip
    ├─→ Return Remaining Seats
    │   ├─ remainingPassengerSeats
    │   ├─ remainingCargoSeats
    │   └─ remainingVehicleSeats
    ├─→ Return Per-Cabin Details
    │   ├─ tripCapacityDetails.passenger[cabin]
    │   ├─ tripCapacityDetails.cargo[cabin]
    │   └─ tripCapacityDetails.vehicle[cabin]
    └─→ Optional: Return Agent Allocations
        └─ If requested: getAgentAllocations(tripId)
```

---

## 8. Trip Reporting and Status Updates

### 8.1 Trip Reporting Workflow

```
As Trip Progresses:
SCHEDULED → ONGOING → COMPLETED
    ↓          ↓           ↓
    •          • Create    • Create TripReport
    •          •  Checkins • Verify bookings
    •          • Verify    • Calculate revenue
    •          •  boardings• Record actuals
    •          •
    •          • status = ONGOING

TripReport Creation:
├─ recordedPassengers: {adults, children, infants}
├─ recordedCargo: {weight, items}
├─ recordedVehicles: {count}
├─ actualRevenue: total collected
├─ verificationStatus: {checkedIn, boarded, verified}
└─ createdAt: Date
```

### 8.2 Reporting Status Values

```
Trip.reportingStatus:
  • NotStarted: Initial state
  • InProgress: Recording in progress
  • Verified: All bookings verified
  • Completed: Final report submitted
```

---

## 9. Data Consistency & Constraints

### 9.1 Trip-Level Constraints

```
Validation Rules:
├─ departureDateTime < arrivalDateTime ✓
├─ bookingOpeningDate < bookingClosingDate (if provided) ✓
├─ bookingClosingDate ≤ departureDateTime ✓
├─ checkInOpeningDate < checkInClosingDate (if provided) ✓
├─ boardingClosingDate ≤ departureDateTime ✓
└─ departurePort ≠ arrivalPort (implied by logic)
```

### 9.2 Capacity Constraints

```
Invariants:
├─ remainingPassengerSeats = sum(cabin.remainingSeat) for passenger cabins
├─ remainingCargoSeats = sum(cabin.remainingSeat) for cargo cabins
├─ remainingVehicleSeats = sum(cabin.remainingSeat) for vehicle cabins
├─ For each cabin: remainingSeat = totalSeat - bookedQuantity
└─ remainingSeat ≥ 0 (cannot go negative)
```

### 9.3 Deletion Constraints

```
Cannot Delete Trip if:
├─ Any AvailabilityAgentAllocation exists (non-deleted)
├─ Any PassengerBooking exists (Confirmed, CheckedIn, Boarded)
├─ Any CargoBooking exists (non-cancelled)
├─ Any VehicleBooking exists (non-cancelled)
└─ Trip status = COMPLETED
```

### 9.4 Edit Constraints

```
Cannot Edit Trip if:
├─ status = COMPLETED
├─ Changing ship AND allocations exist
├─ Changing departure/arrival times AND bookings confirmed
└─ reduceCapacity AND active bookings exceed new capacity
```

---

## 10. Audit Trail

### 10.1 Creator/Updater Tracking

```
Every Trip Document includes:
├─ createdBy: {
│   id: ObjectId,
│   name: String (email),
│   type: "company" | "user" | "system",
│   layer: String (optional - user layer)
  }
├─ updatedBy: {
│   id: ObjectId,
│   name: String,
│   type: "company" | "user" | "system",
│   layer: String
  }
├─ createdAt: Timestamp
├─ updatedAt: Timestamp
└─ isDeleted: Boolean (soft delete flag)
```

---

## 11. API Route Structure

### 11.1 Trip Routes

```
/api/trips/
├─ GET       /                       → listTrips (read)
├─ GET       /:id                    → getTripById (read)
├─ GET       /:id/availability       → getTripAvailability (read)
├─ POST      /                       → createTrip (write)
├─ PUT       /:id                    → updateTrip (edit)
└─ DELETE    /:id                    → deleteTrip (delete)

Sub-routes:
└─ /:tripId/availabilities/
   ├─ GET       /                    → getTripAvailabilities
   ├─ GET       /:availabilityId     → getAvailability
   ├─ POST      /                    → createAvailability
   ├─ PUT       /:availabilityId     → updateAvailability
   └─ DELETE    /:availabilityId     → deleteAvailability
```

### 11.2 Booking Routes

```
/api/passenger-bookings/
├─ GET       /                       → listBookings
├─ GET       /:id                    → getBookingById
├─ POST      /                       → createBooking
├─ PUT       /:id                    → updateBooking
├─ DELETE    /:id                    → cancelBooking

/api/cargo-bookings/
├─ (Same structure as passenger bookings)

/api/vehicle-bookings/
├─ (Same structure as passenger bookings)
```

### 11.3 Agent Allocation Routes

```
/api/agent-allocations/
├─ GET       /                       → listAllocations
├─ GET       /:id                    → getAllocationById
├─ POST      /                       → createAllocation
├─ PUT       /:id                    → updateAllocation
└─ DELETE    /:id                    → deleteAllocation
```

---

## 12. Permission Model

### 12.1 RBAC for Trip Operations

```
Module: "ship-trips"
Resources: "trips", "availabilities", "bookings"

Permissions:
├─ read   → GET /trips, GET /trips/:id
├─ write  → POST /trips (create new trip)
├─ edit   → PUT /trips/:id (modify existing)
├─ delete → DELETE /trips/:id (soft delete)

Affected Roles:
├─ company       → Can manage own trips
├─ admin         → Can manage all company trips
├─ agent/partner → Can view allocations
└─ customer      → Can view available trips
```

---

## 13. Database Indexes

### 13.1 Trip Collection Indexes

```
Indexes:
├─ { company: 1, tripCode: 1 }                      (unique)
├─ { company: 1, departureDateTime: 1 }            (range queries)
├─ { company: 1, ship: 1 }                         (ship filtering)
├─ { company: 1, departurePort: 1, arrivalPort: 1 }(route queries)
├─ { company: 1, status: 1 }                       (status filtering)
└─ { company: 1, isDeleted: 1 }                    (soft delete queries)
```

### 13.2 TripAvailability Indexes

```
Indexes:
├─ { company: 1, trip: 1 }
├─ { company: 1, trip: 1, type: 1 }
└─ { company: 1, trip: 1, isDeleted: 1 }
```

### 13.3 PassengerBooking Indexes

```
Indexes:
├─ { company: 1, bookingReference: 1 }  (unique)
├─ { company: 1, bookingStatus: 1 }
├─ { company: 1, departureDate: 1 }
├─ { company: 1, outboundTrip: 1 }
├─ { company: 1, bookingAgent: 1 }
├─ { company: 1, b2cCustomer: 1 }
└─ { company: 1, isDeleted: 1 }
```

---

## 14. Integration Points

### 14.1 External Services Called During Trip Flow

```
Trip Creation:
└─ Ship Service (fetch capacity details)
└─ Port Service (validate ports exist)
└─ Promotion Service (validate promotion exists)
└─ Cabin Service (fetch cabin names)

Booking Creation:
├─ Trip Service (fetch and update capacity)
├─ PriceList Service (calculate fares)
├─ Tax Service (calculate taxes)
├─ Promotion Service (apply discounts)
├─ Currency Service (handle multi-currency)
└─ Payment Service (process payment)

Agent Allocation:
├─ Partner Service (validate agent)
├─ TripAvailability Service (manage allocations)
└─ Ledger Service (record financial impact)
```

---

## 15. Common Query Patterns

### 15.1 Get Trips with Filters

```
Query: List all SCHEDULED trips for a company on a specific route
  db.trip.find({
    company: ObjectId,
    status: "SCHEDULED",
    departurePort: ObjectId,
    arrivalPort: ObjectId,
    isDeleted: false
  })
  .sort({ departureDateTime: 1 })
```

### 15.2 Get Available Capacity

```
Query: Get remaining seats for a specific trip
  db.trip.findById(tripId)
  .select([
    "remainingPassengerSeats",
    "remainingCargoSeats",
    "remainingVehicleSeats",
    "tripCapacityDetails"
  ])
```

### 15.3 Get Agent Allocations

```
Query: Get all allocations for a trip
  db.availabilityagentallocation.find({
    company: ObjectId,
    trip: ObjectId,
    isDeleted: false
  })
  .populate("agent")
  .populate("availability")
```

---

## 16. Error Handling

### 16.1 Common Errors

```
Validation Errors (400):
├─ "Departure date/time must be before arrival date/time"
├─ "Booking closing date must be on or before departure date/time"
├─ "Trip code already exists for this company"
├─ "Insufficient remaining seats"
└─ "Booking status does not allow cancellation"

Not Found Errors (404):
├─ "Trip not found"
├─ "Ship not found"
├─ "Departure port not found"
├─ "Arrival port not found"
└─ "Booking not found"

Deletion Errors (400):
├─ "Cannot delete trip. Agent allocations exist."
├─ "Cannot delete trip. Bookings exist."
└─ "Cannot delete completed trips"
```

---

## 17. Summary: Trip Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    FERRY TRIP SYSTEM                        │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ CREATE TRIP │
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
    ┌────────┐      ┌──────────┐      ┌──────────────┐
    │ SCHEDULE│      │AVAILABILITIES│  │ BOOKINGS    │
    │ STATUS  │      │ GENERATE    │  │ PENDING     │
    └────────┘      └──────────────┘  └──────────────┘
         │                 │                 │
         │                 ▼                 ▼
         │          ┌──────────────┐   ┌──────────┐
         │          │AGENT ALLOCS  │   │ PAYMENTS │
         │          │CREATION      │   │ PROCESS  │
         │          └──────────────┘   └──────────┘
         │                 │                 │
         └─────────────────┼─────────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ TRIP ONGOING│
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
    ┌────────┐      ┌──────────┐      ┌──────────────┐
    │ CHECKINS│      │ BOARDING │   │ CARGO OPS    │
    │ PROCESS │      │ PROCESS  │    │              │
    └────────┘      └──────────┘     └──────────────┘
         │                 │                 │
         └─────────────────┼─────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │TRIP COMPLETED│
                    └──────┬───────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
    ┌────────┐      ┌──────────┐      ┌──────────────┐
    │ GENERATE│      │ VERIFY   │      │RECORD        │
    │ REPORT  │      │ DATA     │      │ FINANCIALS   │
    └────────┘      └──────────┘      └──────────────┘
         │                 │                 │
         └─────────────────┼─────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │ COMPLETED &  │
                    │ ARCHIVED     │
                    └──────────────┘
```

---

## 18. Key Takeaways

1. **Trips are the Root Entity**: All bookings, allocations, and operations tie back to a Trip.

2. **Capacity Management is Critical**: 
   - Aggregate totals (remainingPassengerSeats, etc.) for quick checks
   - Per-cabin details for granular tracking
   - Restored on booking cancellation

3. **Three Booking Types**:
   - Passenger (adults, children, infants)
   - Cargo (weight-based)
   - Vehicle (dimension-based)

4. **Availability ≠ Booking**:
   - TripAvailability tracks agent allocations
   - Bookings track customer purchases
   - Both decrement from trip capacity

5. **Soft Deletes Throughout**: isDeleted flag prevents hard deletion, maintains audit trail.

6. **Multi-Currency & Multi-Tax**: Prices calculated with currency exchange and tax rates.

7. **RBAC Controls Access**: Permissions enforced at module/resource/action level.

8. **Audit Trail Complete**: Every change tracked with createdBy/updatedBy timestamps.

9. **Reporting Workflow**: Trip completion triggers verification and financial reconciliation.

10. **Constraints Prevent Errors**: Validation rules ensure data consistency at every step.
