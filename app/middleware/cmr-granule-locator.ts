import { NextFunction } from 'express';
import { ServerResponse } from 'http';
import _ from 'lodash';
import { keysToLowerCase } from '../util/object';
import * as cmr from '../util/cmr';
import { CmrError, RequestValidationError, ServerError } from '../util/errors';
import { HarmonyGranule } from '../models/data-operation';
import HarmonyRequest from '../models/harmony-request';
import { computeMbr } from '../util/spatial/mbr';
import { BoundingBox } from '../util/bounding-box';
import env from '../util/env';
import { defaultObjectStore } from '../util/object-store';

/** Reasons why the number of processed granules might be limited to less than what the CMR
 * returns
 */
enum GranuleLimitReason {
  Collection, // limited by the collection configuration
  MaxResults, // limited by the maxResults query parameter
  System,     // limited by the system environment
  None,       // not limited
}

/**
 * Gets collection from request that matches the given id
 * @param req - The client request
 * @param collectionId - the CMR concept id of the collection to find
 * @returns the collection from the request that has the given id
 */
function getCollectionFromRequest(req: HarmonyRequest, collectionId: string): cmr.CmrCollection {
  return req.collections.find((collection) => collection.id === collectionId);
}

/**
 * Gets bbox
 * @param collection - a CMR collection record
 * @param granule  -  a CMR granule record associated with the `collection`
 * @returns bbox  - a bounding box in [W S E N] format
 */
function getBbox(collection: cmr.CmrCollection, granule: cmr.CmrGranule): BoundingBox {
  // use the given bounding box (if any), else try to use the given spatial geometry
  // to find a box; if there is none, use the spatial geometry from the collection; if
  // there is none default to a bounding box for the whole world
  return computeMbr(granule)
    || computeMbr(collection)
    || [-180, -90, 180, 90];
}

/**
 * Get the maximum number of granules that should be used from the CMR results
 * 
 * @param req - The client request, containing an operation
 * @param collection - The id of the collection to which the granules belong
 * @returns a tuple containing the maximum number of granules to return from the CMR and the
 * reason why it is being limited
 */
function getMaxGranules(req: HarmonyRequest, collection: string): { maxGranules: number; reason: GranuleLimitReason; } {
  let reason = GranuleLimitReason.None;
  let maxResults = Number.MAX_SAFE_INTEGER;

  if (req.context.serviceConfig.has_granule_limit !== false) {
    const query = keysToLowerCase(req.query);
    const { context } = req;
    maxResults = env.maxGranuleLimit;
    reason = GranuleLimitReason.System;

    if ('maxresults' in query && query.maxresults < maxResults) {
      maxResults = query.maxresults;
      reason = GranuleLimitReason.MaxResults;
    }

    const { serviceConfig } = context;
    const serviceCollection = serviceConfig.collections?.find((sc) => sc.id === collection);
    if (serviceCollection &&
      serviceCollection.granuleLimit &&
      serviceCollection.granuleLimit < maxResults) {
      maxResults = serviceCollection.granuleLimit;
      reason = GranuleLimitReason.Collection;
    }
  }

  return { maxGranules: maxResults, reason };
}

/**
 * Create a message indicating that the results have been limited and why - if necessary
 * 
 * @param req - The client request, containing an operation
 * @param collection - The id of the collection to which the granules belong
 * @returns a warning message if not all matching granules will be processed, or undefined
 * if not applicable 
 */
function getResultsLimitedMessage(req: HarmonyRequest, collection: string): string {
  const { operation } = req;
  let message;

  if ( req.context.serviceConfig.has_granule_limit == false ) return message;

  const { maxGranules, reason } = getMaxGranules(req, collection);

  if (operation.cmrHits > maxGranules) {
    message = `CMR query identified ${operation.cmrHits} granules, but the request has been limited `
      + `to process only the first ${maxGranules} granules`;

    switch (reason) {
      case GranuleLimitReason.MaxResults:
        message += ` because you requested ${operation.maxResults} maxResults.`;
        break;

      case GranuleLimitReason.Collection:
        message += ` because collection ${collection} is limited to ${maxGranules} for the ${req.context.serviceConfig.name} service.`;
        break;

      default:
        message += ' because of system constraints.';
        break;
    }
  }
  return message;
}

/**
 * Express.js middleware which extracts parameters from the Harmony operation
 * and performs a granule query on them, determining which files are applicable
 * to the given operation. Adds a CMR scrolling ID to be used by the query-cmr
 * task to retrieve the granules as part of a turbo workflow.
 *
 * @param req - The client request, containing an operation
 * @param res - The client response
 * @param next - The next function in the middleware chain
 */
async function cmrGranuleLocatorTurbo(
  req: HarmonyRequest, res: ServerResponse, next: NextFunction,
): Promise<void> {
  // Same boilerplate as before
  const { operation } = req;
  const { logger } = req.context;

  if (!operation) return next();

  const cmrQuery: cmr.CmrQuery = {};

  const start = operation.temporal?.start;
  const end = operation.temporal?.end;
  if (start || end) {
    cmrQuery.temporal = `${start || ''},${end || ''}`;
  }
  if (operation.boundingRectangle) {
    cmrQuery.bounding_box = operation.boundingRectangle.join(',');
  } else if (operation.spatialPoint) {
    cmrQuery.point = operation.spatialPoint.join(',');
  }

  cmrQuery.concept_id = operation.granuleIds;

  operation.cmrHits = 0;
  operation.scrollIDs = [];

  try {
    const { sources } = operation;
    const queries = sources.map(async (source) => {
      logger.info(`Querying granules for ${source.collection}`, { cmrQuery, collection: source.collection });
      const startTime = new Date().getTime();
      const { maxGranules } = getMaxGranules(req, source.collection);

      operation.maxResults = maxGranules;

      if (operation.geojson) {
        cmrQuery.geojson = operation.geojson;
      }

      // Only perform CMR granule query when needed by the first step
      if ( req.context.serviceConfig.steps[0].image.match('harmonyservices/query-cmr:.*') ) {
        const { hits, scrollID } = await cmr.initiateGranuleScroll(
          source.collection,
          cmrQuery,
          req.accessToken,
          maxGranules,
        );
        if (hits === 0) {
          throw new RequestValidationError('No matching granules found.');
        }
        const msTaken = new Date().getTime() - startTime;
        logger.info('timing.cmr-initiate-granule-scroll.end', { durationMs: msTaken, hits });

        operation.cmrHits += hits;
        operation.scrollIDs.push(scrollID);
      }

      const limitedMessage = getResultsLimitedMessage(req, source.collection);
      if (limitedMessage) {
        req.context.messages.push(limitedMessage);
      }
    });
    await Promise.all(queries);
  } catch (e) {
    if (e instanceof RequestValidationError || e instanceof CmrError) {
      // Avoid giving confusing errors about GeoJSON due to upstream converted files
      if (e.message.indexOf('GeoJSON') !== -1 && req.context.shapefile) {
        e.message = e.message.replace('GeoJSON', `GeoJSON (converted from the provided ${req.context.shapefile.typeName})`);
      }
      return next(e);
    }
    logger.error(e);
    next(new ServerError('Failed to query the CMR'));
  }
  return next();
}

/**
 * Express.js middleware which extracts parameters from the Harmony operation
 * and performs a granule query on them, determining which files are applicable
 * to the given operation.
 *
 * Still used for the NoOpService and for HTTP based services
 *
 * @param req - The client request, containing an operation
 * @param res - The client response
 * @param next - The next function in the middleware chain
 */
async function cmrGranuleLocatorNonTurbo(
  req: HarmonyRequest, res: ServerResponse, next: NextFunction,
): Promise<void> {
  const { operation } = req;
  const { logger } = req.context;

  if (!operation) return next();

  let cmrResponse;

  const cmrQuery: cmr.CmrQuery = {};

  const start = operation.temporal?.start;
  const end = operation.temporal?.end;
  if (start || end) {
    cmrQuery.temporal = `${start || ''},${end || ''}`;
  }
  if (operation.boundingRectangle) {
    cmrQuery.bounding_box = operation.boundingRectangle.join(',');
  } else if (operation.spatialPoint) {
    cmrQuery.point = operation.spatialPoint.join(',');
  }

  cmrQuery.concept_id = operation.granuleIds;

  operation.cmrHits = 0;
  try {
    const artifactPrefix = `s3://${env.artifactBucket}/harmony-inputs/query/${req.context.id}/`;
    const { sources } = operation;
    const queries = sources.map(async (source, i) => {
      logger.info(`Querying granules for ${source.collection}`, { cmrQuery, collection: source.collection });
      const startTime = new Date().getTime();
      const { maxGranules } = getMaxGranules(req, source.collection);

      operation.maxResults = maxGranules;

      if (operation.geojson) {
        cmrQuery.geojson = operation.geojson;
      }
      cmrResponse = await cmr.queryGranulesForCollection(
        source.collection,
        cmrQuery,
        req.accessToken,
        maxGranules,
      );

      const indexStr = `${i}`.padStart(5, '0');
      const artifactUrl = `${artifactPrefix}query${indexStr}.json`;
      await defaultObjectStore().upload(JSON.stringify(cmrQuery), artifactUrl);
      operation.cmrQueryLocations.push(artifactUrl);

      const { hits, granules: jsonGranules } = cmrResponse;

      operation.cmrHits += hits;
      const msTaken = new Date().getTime() - startTime;
      logger.info('timing.cmr-granule-query.end', { durationMs: msTaken, hits });
      const granules = [];
      for (const granule of jsonGranules) {
        const links = cmr.filterGranuleLinks(granule);
        if (links.length > 0) {
          const collection = getCollectionFromRequest(req, source.collection);
          const box = getBbox(collection, granule);
          const gran: HarmonyGranule = {
            id: granule.id,
            name: granule.title,
            url: links[0].href,
            bbox: box,
            temporal: {
              start: granule.time_start,
              end: granule.time_end,
            },
          };
          granules.push(gran);
        }
      }
      if (granules.length === 0) {
        throw new RequestValidationError('No matching granules found.');
      }
      const limitedMessage = getResultsLimitedMessage(req, source.collection);
      if (limitedMessage) {
        req.context.messages.push(limitedMessage);
      }
      return Object.assign(source, { granules });
    });

    await Promise.all(queries);
    operation.cmrQueryLocations = operation.cmrQueryLocations.sort();
  } catch (e) {
    if (e instanceof RequestValidationError || e instanceof CmrError) {
      // Avoid giving confusing errors about GeoJSON due to upstream converted files
      if (e.message.indexOf('GeoJSON') !== -1 && req.context.shapefile) {
        e.message = e.message.replace('GeoJSON', `GeoJSON (converted from the provided ${req.context.shapefile.typeName})`);
      }
      return next(e);
    }
    logger.error(e);
    next(new ServerError('Failed to query the CMR'));
  }
  return next();
}

/**
 * Express.js middleware which extracts parameters from the Harmony operation
 * and performs a granule query on them, determining which files are applicable
 * to the given operation.
 *
 * @param req - The client request, containing an operation
 * @param res - The client response
 * @param next - The next function in the middleware chain
 */
export default async function cmrGranuleLocator(
  req: HarmonyRequest, res: ServerResponse, next: NextFunction,
): Promise<void> {
  if (req.context?.serviceConfig?.type?.name === 'turbo') {
    await cmrGranuleLocatorTurbo(req, res, next);
  } else {
    await cmrGranuleLocatorNonTurbo(req, res, next);
  }
}
