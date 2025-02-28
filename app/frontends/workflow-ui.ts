import { Response, NextFunction } from 'express';
import { sanitizeImage } from '../util/string';
import { validateJobId } from '../util/job';
import { Job, JobStatus, JobQuery } from '../models/job';
import { getWorkItemsByJobId, WorkItemStatus } from '../models/work-item';
import { NotFoundError } from '../util/errors';
import { getPagingParams, getPagingLinks, setPagingHeaders } from '../util/pagination';
import HarmonyRequest from '../models/harmony-request';
import db from '../util/db';
import version from '../util/version';
import env = require('../util/env');

/**
 * Display jobs along with their status in the workflow UI.
 *
 * @param req - The request sent by the client
 * @param res - The response to send to the client
 * @param next - The next function in the call chain
 * @returns HTML page of clickable jobs which take the user to a
 * page where they can visualize the whole workflow as it happens
 */
export async function getJobs(
  req: HarmonyRequest, res: Response, next: NextFunction,
): Promise<void> {
  const badgeClasses = {};
  badgeClasses[JobStatus.ACCEPTED] = 'primary';
  badgeClasses[JobStatus.CANCELED] = 'secondary';
  badgeClasses[JobStatus.FAILED] = 'danger';
  badgeClasses[JobStatus.SUCCESSFUL] = 'success';
  badgeClasses[JobStatus.RUNNING] = 'info';
  try {
    const { page, limit } = getPagingParams(req, env.defaultJobListPageSize, true);
    const query: JobQuery = {};
    if (!req.context.isAdminAccess) {
      query.username = req.user;
    }
    const { data: jobs, pagination } = await Job.queryAll(db, query, false, page, limit);
    const pageLinks = getPagingLinks(req, pagination);
    const nextPage = pageLinks.find((l) => l.rel === 'next');
    const previousPage = pageLinks.find((l) => l.rel === 'prev');
    setPagingHeaders(res, pagination);
    res.render('workflow-ui/jobs/index', {
      jobs,
      version,
      jobBadge() { return badgeClasses[this.status]; },
      jobUrl() {
        try {
          const url = new URL(this.request);
          const path = url.pathname + url.search;
          return path;
        } catch (e) {
          req.context.logger.error(`Could not form a valid URL from job.request: ${this.request}`);
          req.context.logger.error(e);
          return this.request;
        }
      },
      jobCreatedAt() { return this.createdAt.getTime(); },
      links: [
        { ...previousPage, linkTitle: 'previous' },
        { ...nextPage, linkTitle: 'next' },
      ],
      linkDisabled() { return (this.href ? '' : 'disabled'); },
      linkHref() { return (this.href || ''); },
      isAdminRoute: req.context.isAdminAccess,
    });
  } catch (e) {
    req.context.logger.error(e);
    next(e);
  }
}

/**
 * Display a job's progress and work items in the workflow UI.
 *
 * @param req - The request sent by the client
 * @param res - The response to send to the client
 * @param next - The next function in the call chain
 * @returns The workflow UI page where the user can visualize the job as it happens
 */
export async function getJob(
  req: HarmonyRequest, res: Response, next: NextFunction,
): Promise<void> {
  const { jobID } = req.params;
  try {
    validateJobId(jobID);
    const { page, limit } = getPagingParams(req, 1000);
    const query: JobQuery = { requestId: jobID };
    if (!req.context.isAdminAccess) {
      query.username = req.user;
    }
    const { job } = await Job.byRequestId(db, jobID, 0, 0);
    if (job) {
      if (!(await job.canShareResultsWith(req.user, req.context.isAdminAccess, req.accessToken))) {
        throw new NotFoundError();
      }
      res.render('workflow-ui/job/index', {
        job,
        page,
        limit,
        version,
        isAdminRoute: req.context.isAdminAccess,
      });
    } else {
      throw new NotFoundError(`Unable to find job ${jobID}`);
    }
  } catch (e) {
    req.context.logger.error(e);
    next(e);
  }
}

/**
 * Render the work items table for the workflow UI.
 *
 * @param req - The request sent by the client
 * @param res - The response to send to the client
 * @param next - The next function in the call chain
 * @returns The work items table HTML
 */
export async function getWorkItemsTable(
  req: HarmonyRequest, res: Response, next: NextFunction,
): Promise<void> {
  const { jobID } = req.params;
  const { checkJobStatus } = req.query;
  const badgeClasses = {};
  badgeClasses[WorkItemStatus.READY] = 'primary';
  badgeClasses[WorkItemStatus.CANCELED] = 'secondary';
  badgeClasses[WorkItemStatus.FAILED] = 'danger';
  badgeClasses[WorkItemStatus.SUCCESSFUL] = 'success';
  badgeClasses[WorkItemStatus.RUNNING] = 'info';
  try {
    validateJobId(jobID);
    const query: JobQuery = { requestId: jobID };
    if (!req.context.isAdminAccess) {
      query.username = req.user;
    }
    const { job } = await Job.byRequestId(db, jobID, 0, 0);
    if (job) {
      if (!(await job.canShareResultsWith(req.user, req.context.isAdminAccess, req.accessToken))) {
        throw new NotFoundError();
      }
      if (([JobStatus.SUCCESSFUL, JobStatus.CANCELED, JobStatus.FAILED].indexOf(job.status) > -1) && checkJobStatus === 'true') {
        // tell the client that the job has finished
        res.status(204).json({ status: job.status });
        return;
      }
      const { page, limit } = getPagingParams(req, env.defaultJobListPageSize);
      const { workItems, pagination } = await getWorkItemsByJobId(db, job.jobID, page, limit, 'asc');
      const pageLinks = getPagingLinks(req, pagination);
      const nextPage = pageLinks.find((l) => l.rel === 'next');
      const previousPage = pageLinks.find((l) => l.rel === 'prev');
      setPagingHeaders(res, pagination);
      res.render('workflow-ui/job/work-items-table', {
        workItems,
        workflowItemBadge() { return badgeClasses[this.status]; },
        workflowItemStep() { return sanitizeImage(this.serviceID); },
        workflowItemCreatedAt() { return this.createdAt.getTime(); },
        workflowItemUpdatedAt() { return this.updatedAt.getTime(); },
        links: [
          { ...previousPage, linkTitle: 'previous' },
          { ...nextPage, linkTitle: 'next' },
        ],
        linkDisabled() { return (this.href ? '' : 'disabled'); },
        linkHref() {
          return (this.href ? this.href
            .replace('/work-items', '')
            .replace(/(&|\?)checkJobStatus=(true|false)/, '') : '');
        },
      });
    } else {
      throw new NotFoundError(`Unable to find job ${jobID}`);
    }
  } catch (e) {
    req.context.logger.error(e);
    next(e);
  }
}
