/**
 * @typedef {object} AgencyConfig
 * @property {string} slug
 * @property {string} name
 * @property {string} [location]
 * @property {number} lat
 * @property {number} lon
 * @property {number} spanDelta
 * @property {string} [fareLink]
 * @property {string} [mdbStaticId]
 * @property {string} gtfsStaticUrl
 * @property {string} vehiclePositionsUrl
 * @property {string} [tripUpdatesUrl]
 * @property {string} [alertsUrl]
 * @property {string} [apiKeySecret]
 * @property {string} [apiKeyEnv]
 * @property {string} [rtAgencyCode]
 */

/**
 * @typedef {object} AgencyAdapter
 * @property {string} slug
 * @property {string} [notes]
 * @property {(agency: AgencyConfig, apiKey: string|null) => string} buildVehicleFeedUrl
 * @property {(agency: AgencyConfig, apiKey: string|null) => string} [buildTripUpdateFeedUrl]
 * @property {(agency: AgencyConfig, apiKey: string|null) => Record<string, string>} [buildVehicleFeedHeaders]
 * @property {(id: string|null|undefined) => string} normalizeRouteId
 * @property {(entity: object, staticIndex: { tripToRoute: Map<string,string>, routeIds: Set<string> }) => { routeId: string|null, method: string }} extractRouteId
 */

export {};
