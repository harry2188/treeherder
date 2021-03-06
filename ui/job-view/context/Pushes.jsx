import React from 'react';
import PropTypes from 'prop-types';
import pick from 'lodash/pick';
import keyBy from 'lodash/keyBy';
import isEqual from 'lodash/isEqual';
import max from 'lodash/max';

import {
  thDefaultRepo,
  thEvents,
  thMaxPushFetchSize,
} from '../../helpers/constants';
import { parseQueryParams } from '../../helpers/url';
import {
  getAllUrlParams,
  getQueryString,
  getUrlParam,
  setLocation,
  setUrlParam,
} from '../../helpers/location';
import { isUnclassifiedFailure } from '../../helpers/job';
import PushModel from '../../models/push';
import JobModel from '../../models/job';
import { reloadOnChangeParameters } from '../../helpers/filter';
import { withNotifications } from '../../shared/context/Notifications';

const PushesContext = React.createContext({});
const defaultPushCount = 10;
// Keys that, if present on the url, must be passed into the push
// polling endpoint
const pushPollingKeys = ['tochange', 'enddate', 'revision', 'author'];
const pushFetchKeys = [...pushPollingKeys, 'fromchange', 'startdate'];
const pushPollInterval = 60000;

export class PushesClass extends React.Component {
  constructor(props) {
    super(props);

    this.skipNextPageReload = false;

    this.state = {
      pushList: [],
      jobMap: {},
      revisionTips: [],
      jobsLoaded: false,
      loadingPushes: true,
      oldestPushTimestamp: null,
      latestJobTimestamp: null,
      cachedReloadTriggerParams: this.getNewReloadTriggerParams(),
      allUnclassifiedFailureCount: 0,
      filteredUnclassifiedFailureCount: 0,
    };
    this.value = {
      ...this.state,
      updateJobMap: this.updateJobMap,
      getAllShownJobs: this.getAllShownJobs,
      fetchPushes: this.fetchPushes,
      recalculateUnclassifiedCounts: this.recalculateUnclassifiedCounts,
      setRevisionTips: this.setRevisionTips,
      addPushes: this.addPushes,
      getPush: this.getPush,
      updateUrlFromchange: this.updateUrlFromchange,
      getNextPushes: this.getNextPushes,
      handleUrlChanges: this.handleUrlChanges,
      getGeckoDecisionJob: this.getGeckoDecisionJob,
      getGeckoDecisionTaskId: this.getGeckoDecisionTaskId,
    };
  }

  componentDidMount() {
    this.setValue = this.setValue.bind(this);
    this.updateJobMap = this.updateJobMap.bind(this);
    this.getAllShownJobs = this.getAllShownJobs.bind(this);
    this.fetchPushes = this.fetchPushes.bind(this);
    this.recalculateUnclassifiedCounts = this.recalculateUnclassifiedCounts.bind(
      this,
    );
    this.setRevisionTips = this.setRevisionTips.bind(this);
    this.addPushes = this.addPushes.bind(this);
    this.getPush = this.getPush.bind(this);
    this.updateUrlFromchange = this.updateUrlFromchange.bind(this);
    this.getNextPushes = this.getNextPushes.bind(this);
    this.handleUrlChanges = this.handleUrlChanges.bind(this);
    this.getGeckoDecisionJob = this.getGeckoDecisionJob.bind(this);
    this.getGeckoDecisionTaskId = this.getGeckoDecisionTaskId.bind(this);
    this.getLastModifiedJobTime = this.getLastModifiedJobTime.bind(this);
    this.poll = this.poll.bind(this);

    // TODO: this.value needs to now get the bound versions of the functions.
    // But when we move the function binding to the constructors, we won't
    // have to re-do this in componentDidMount.
    this.value = {
      ...this.state,
      updateJobMap: this.updateJobMap,
      getAllShownJobs: this.getAllShownJobs,
      fetchPushes: this.fetchPushes,
      recalculateUnclassifiedCounts: this.recalculateUnclassifiedCounts,
      setRevisionTips: this.setRevisionTips,
      addPushes: this.addPushes,
      getPush: this.getPush,
      updateUrlFromchange: this.updateUrlFromchange,
      getNextPushes: this.getNextPushes,
      handleUrlChanges: this.handleUrlChanges,
      getGeckoDecisionJob: this.getGeckoDecisionJob,
      getGeckoDecisionTaskId: this.getGeckoDecisionTaskId,
    };

    window.addEventListener('hashchange', this.handleUrlChanges, false);

    // get our first set of resultsets
    const fromchange = getUrlParam('fromchange');
    // If we have a ``fromchange`` url param.  We don't want to limit ourselves
    // to the default of 10 pushes on the first load.
    this.fetchPushes(fromchange ? thMaxPushFetchSize : defaultPushCount);
    this.poll();
  }

  componentWillUnmount() {
    if (this.pushIntervalId) {
      clearInterval(this.pushIntervalId);
      this.pushIntervalId = null;
    }
  }

  setValue(newState, callback) {
    this.value = { ...this.value, ...newState };
    this.setState(newState, callback);
  }

  getNewReloadTriggerParams() {
    const params = parseQueryParams(getQueryString());

    return reloadOnChangeParameters.reduce(
      (acc, prop) => (params[prop] ? { ...acc, [prop]: params[prop] } : acc),
      {},
    );
  }

  getAllShownJobs(pushId) {
    const { jobMap } = this.state;
    const jobList = Object.values(jobMap);

    return pushId
      ? jobList.filter(job => job.push_id === pushId && job.visible)
      : jobList.filter(job => job.visible);
  }

  setRevisionTips() {
    const { pushList } = this.state;

    this.setValue({
      revisionTips: pushList.map(push => ({
        revision: push.revision,
        author: push.author,
        title: push.revisions[0].comments.split('\n')[0],
      })),
    });
  }

  getPush(pushId) {
    const { pushList } = this.state;

    return pushList.find(push => pushId === push.id);
  }

  getNextPushes(count) {
    const params = getAllUrlParams();

    this.setValue({ loadingPushes: true });
    if (params.has('revision')) {
      // We are viewing a single revision, but the user has asked for more.
      // So we must replace the ``revision`` param with ``tochange``, which
      // will make it just the top of the range.  We will also then get a new
      // ``fromchange`` param after the fetch.
      this.skipNextPageReload = true;
      const revision = params.get('revision');
      params.delete('revision');
      params.set('tochange', revision);
      setLocation(params);
    } else if (params.has('startdate')) {
      // We are fetching more pushes, so we don't want to limit ourselves by
      // ``startdate``.  And after the fetch, ``startdate`` will be invalid,
      // and will be replaced on the location bar by ``fromchange``.
      this.skipNextPageReload = true;
      setUrlParam('startdate', null);
    }
    this.fetchPushes(count).then(this.updateUrlFromchange);
  }

  getGeckoDecisionJob(pushId) {
    const { jobMap } = this.state;

    return Object.values(jobMap).find(
      job =>
        job.push_id === pushId &&
        job.platform === 'gecko-decision' &&
        job.state === 'completed' &&
        job.job_type_symbol === 'D',
    );
  }

  getGeckoDecisionTaskId(pushId, repoName) {
    const decisionTask = this.getGeckoDecisionJob(pushId);
    if (decisionTask) {
      return JobModel.get(repoName, decisionTask.id).then(job => {
        // this failure case is unlikely, but I guess you
        // never know
        if (!job.taskcluster_metadata) {
          return Promise.reject('Decision task missing taskcluster metadata');
        }
        return job.taskcluster_metadata.task_id;
      });
    }

    // no decision task, we fail
    return Promise.reject('No decision task');
  }

  getLastModifiedJobTime() {
    const { jobMap } = this.state;
    const latest =
      max(
        Object.values(jobMap).map(job => new Date(`${job.last_modified}Z`)),
      ) || new Date();

    latest.setSeconds(latest.getSeconds() - 3);
    return latest;
  }

  poll() {
    this.pushIntervalId = setInterval(() => {
      const { notify } = this.props;
      const { pushList } = this.state;
      // these params will be passed in each time we poll to remain
      // within the constraints of the URL params
      const locationSearch = parseQueryParams(getQueryString());
      const pushPollingParams = pushPollingKeys.reduce(
        (acc, prop) =>
          locationSearch[prop] ? { ...acc, [prop]: locationSearch[prop] } : acc,
        {},
      );

      if (pushList.length === 1 && locationSearch.revision) {
        // If we are on a single revision, no need to poll for more pushes, but
        // we need to keep polling for jobs.
        this.fetchNewJobs();
      } else {
        if (pushList.length) {
          // We have a range of pushes, but not bound to a single push,
          // so get only pushes newer than our latest.
          pushPollingParams.fromchange = pushList[pushList.length - 1].revision;
        }
        // We will either have a ``revision`` param, but no push for it yet,
        // or a ``fromchange`` param because we have at least 1 push already.
        PushModel.getList(pushPollingParams).then(async resp => {
          if (resp.ok) {
            const data = await resp.json();
            this.addPushes(data);
            this.fetchNewJobs();
          } else {
            notify('Error fetching new push data', 'danger', { sticky: true });
          }
        });
      }
    }, pushPollInterval);
  }

  // reload the page if certain params were changed in the URL.  For
  // others, such as filtering, just re-filter without reload.

  // the param ``skipNextPageReload`` will cause a single run through
  // this code to skip the page reloading even on a param that would
  // otherwise trigger a page reload.  This is useful for a param that
  // is being changed by code in a specific situation as opposed to when
  // the user manually edits the URL location bar.
  handleUrlChanges() {
    const { cachedReloadTriggerParams } = this.state;
    const newReloadTriggerParams = this.getNewReloadTriggerParams();
    // if we are just setting the repo to the default because none was
    // set initially, then don't reload the page.
    const defaulting =
      newReloadTriggerParams.repo === thDefaultRepo &&
      !cachedReloadTriggerParams.repo;

    if (
      !defaulting &&
      cachedReloadTriggerParams &&
      !isEqual(newReloadTriggerParams, cachedReloadTriggerParams) &&
      !this.skipNextPageReload
    ) {
      window.location.reload();
    } else {
      this.setState({ cachedReloadTriggerParams: newReloadTriggerParams });
    }

    this.skipNextPageReload = false;

    this.recalculateUnclassifiedCounts();
  }

  /**
   * Get the next batch of pushes based on our current offset.
   * @param count How many to fetch
   */
  fetchPushes(count) {
    const { notify } = this.props;
    const { oldestPushTimestamp } = this.state;
    // const isAppend = (repoData.pushes.length > 0);
    // Only pass supported query string params to this endpoint.
    const options = {
      ...pick(parseQueryParams(getQueryString()), pushFetchKeys),
      count,
    };

    if (oldestPushTimestamp) {
      // If we have an oldestTimestamp, then this isn't our first fetch,
      // we're fetching more pushes.  We don't want to limit this fetch
      // by the current ``fromchange`` or ``tochange`` value.  Deleting
      // these params here do not affect the params on the location bar.
      delete options.fromchange;
      delete options.tochange;
      options.push_timestamp__lte = oldestPushTimestamp;
    }
    return PushModel.getList(options)
      .then(async resp => {
        if (resp.ok) {
          const data = await resp.json();

          this.addPushes(data.results.length ? data : { results: [] });
        } else {
          notify('Error retrieving push data!', 'danger', { sticky: true });
        }
      })
      .then(() => this.setValue({ loadingPushes: false }));
  }

  addPushes(data) {
    const { pushList } = this.state;

    if (data.results.length > 0) {
      const pushIds = pushList.map(push => push.id);
      const newPushList = [
        ...pushList,
        ...data.results.filter(push => !pushIds.includes(push.id)),
      ];
      newPushList.sort((a, b) => b.push_timestamp - a.push_timestamp);
      const oldestPushTimestamp =
        newPushList[newPushList.length - 1].push_timestamp;
      this.recalculateUnclassifiedCounts();
      this.setValue({ pushList: newPushList, oldestPushTimestamp }, () =>
        this.setRevisionTips(),
      );
    }
  }

  async fetchNewJobs() {
    const { pushList } = this.state;
    if (!pushList.length) {
      // If we have no pushes, then no need to poll for jobs.
      return;
    }
    const pushIds = pushList.map(push => push.id);
    const lastModified = this.getLastModifiedJobTime();
    const jobList = await PushModel.getJobs(pushIds, { lastModified });
    // break the jobs up per push
    const jobs = jobList.reduce((acc, job) => {
      const pushJobs = acc[job.push_id] ? [...acc[job.push_id], job] : [job];
      return { ...acc, [job.push_id]: pushJobs };
    }, {});
    // If a job is selected, and one of the jobs we just fetched is the
    // updated version of that selected job, then send that with the event.
    const selectedJobId = getUrlParam('selectedJob');
    const updatedSelectedJob = selectedJobId
      ? jobList.find(job => job.id === parseInt(selectedJobId, 10))
      : null;

    window.dispatchEvent(
      new CustomEvent(thEvents.applyNewJobs, {
        detail: { jobs, updatedSelectedJob },
      }),
    );
  }

  updateUrlFromchange() {
    // since we fetched more pushes, we need to persist the push state in the URL.
    const { pushList } = this.state;
    const updatedLastRevision = pushList[pushList.length - 1].revision;

    if (getUrlParam('fromchange') !== updatedLastRevision) {
      this.skipNextPageReload = true;
      setUrlParam('fromchange', updatedLastRevision);
    }
  }

  /**
   * Loops through the map of unclassified failures and checks if it is
   * within the enabled tiers and if the job should be shown. This essentially
   * gives us the difference in unclassified failures and, of those jobs, the
   * ones that have been filtered out
   */
  recalculateUnclassifiedCounts() {
    const { jobMap } = this.state;
    const { filterModel } = this.props;
    const tiers = filterModel.urlParams.tier || [];
    let allUnclassifiedFailureCount = 0;
    let filteredUnclassifiedFailureCount = 0;

    Object.values(jobMap).forEach(job => {
      if (isUnclassifiedFailure(job)) {
        if (tiers.includes(String(job.tier))) {
          if (filterModel.showJob(job)) {
            filteredUnclassifiedFailureCount++;
          }
          allUnclassifiedFailureCount++;
        }
      }
    });
    this.setValue({
      allUnclassifiedFailureCount,
      filteredUnclassifiedFailureCount,
    });
  }

  updateJobMap(jobList) {
    const { jobMap, pushList } = this.state;

    if (jobList.length) {
      // lodash ``keyBy`` is significantly faster than doing a ``reduce``
      this.setValue({
        jobMap: { ...jobMap, ...keyBy(jobList, 'id') },
        jobsLoaded: pushList.every(push => push.jobsLoaded),
        pushList: [...pushList],
      });
    }
  }

  render() {
    return (
      <PushesContext.Provider value={this.value}>
        {this.props.children}
      </PushesContext.Provider>
    );
  }
}

PushesClass.propTypes = {
  children: PropTypes.object.isRequired,
  filterModel: PropTypes.object.isRequired,
  notify: PropTypes.func.isRequired,
};

export const Pushes = withNotifications(PushesClass);

export function withPushes(Component) {
  return function PushesComponent(props) {
    return (
      <PushesContext.Consumer>
        {context => (
          <Component
            {...props}
            pushList={context.pushList}
            revisionTips={context.revisionTips}
            jobMap={context.jobMap}
            jobsLoaded={context.jobsLoaded}
            loadingPushes={context.loadingPushes}
            allUnclassifiedFailureCount={context.allUnclassifiedFailureCount}
            filteredUnclassifiedFailureCount={
              context.filteredUnclassifiedFailureCount
            }
            updateJobMap={context.updateJobMap}
            getAllShownJobs={context.getAllShownJobs}
            fetchPushes={context.fetchPushes}
            getPush={context.getPush}
            recalculateUnclassifiedCounts={
              context.recalculateUnclassifiedCounts
            }
            getNextPushes={context.getNextPushes}
            getGeckoDecisionJob={context.getGeckoDecisionJob}
            getGeckoDecisionTaskId={context.getGeckoDecisionTaskId}
          />
        )}
      </PushesContext.Consumer>
    );
  };
}
