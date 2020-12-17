import {
  all,
  call,
  fork,
  put,
  select,
  take,
  takeEvery,
  takeLatest,
} from "redux-saga/effects";
import { eventChannel, EventChannel, channel, Channel } from "redux-saga";
import {
  EvaluationReduxAction,
  ReduxAction,
  ReduxActionErrorTypes,
  ReduxActionTypes,
} from "constants/ReduxActionConstants";
import {
  getDataTree,
  getUnevaluatedDataTree,
} from "selectors/dataTreeSelectors";
import WidgetFactory, { WidgetTypeConfigMap } from "../utils/WidgetFactory";
import Worker from "worker-loader!../workers/evaluation.worker";
import {
  EVAL_WORKER_ACTIONS,
  EvalError,
  EvalErrorTypes,
} from "../utils/DynamicBindingUtils";
import log from "loglevel";
import _ from "lodash";
import { WidgetType } from "../constants/WidgetConstants";
import { WidgetProps } from "../widgets/BaseWidget";
import PerformanceTracker, {
  PerformanceTransactionName,
} from "../utils/PerformanceTracker";
import { Variant } from "components/ads/common";
import { Toaster } from "components/ads/Toast";
import * as Sentry from "@sentry/react";
import { EXECUTION_PARAM_KEY } from "../constants/ActionConstants";

let widgetTypeConfigMap: WidgetTypeConfigMap;
const worker = new (class WorkerBroker {
  private _channels: { [k: string]: Channel<any> } = {};
  private _workerChannel: EventChannel<any> | undefined;
  private _evaluationWorker: Worker | undefined;

  constructor() {
    this.init = this.init.bind(this);
    this.request = this.request.bind(this);
    this.isReady = this.isReady.bind(this);
    this._broker = this._broker.bind(this);
  }

  *init() {
    // Todo: ask where this is used.
    if (this._evaluationWorker) {
      this._evaluationWorker.terminate();
      this._evaluationWorker = undefined;
    }
    widgetTypeConfigMap = WidgetFactory.getWidgetTypeConfigMap();
    this._evaluationWorker = new Worker();
    this._workerChannel = eventChannel(emitter => {
      if (!this._evaluationWorker) {
        // Todo: figure how to handle this.
        return _.noop;
      }
      this._evaluationWorker.addEventListener("message", emitter);
      // The subscriber must return an unsubscribe function
      return () => {
        if (!this._evaluationWorker) return;
        this._evaluationWorker.removeEventListener("message", emitter);
      };
    });

    const evalWorkerActions = Object.values(EVAL_WORKER_ACTIONS);
    for (const action of evalWorkerActions) {
      this._channels[action] = yield call(channel);
    }
    // Todo: figure out how to make this repeatable
    yield takeEvery(this._workerChannel, this._broker);
  }

  isReady() {
    return !!this._evaluationWorker;
  }

  *request(action: string, payload = {}) {
    // Todo: should I raise here?
    if (!this._evaluationWorker) return;

    this._evaluationWorker.postMessage({
      action,
      ...payload,
    });

    return yield take(this._channels[action]);
  }

  private *_broker(event: MessageEvent) {
    if (!event || !event.data) {
      return;
    }
    const { action, message } = event.data;
    yield put(this._channels[action], message);
  }
})();

const evalErrorHandler = (errors: EvalError[]) => {
  if (!errors) return;
  errors.forEach(error => {
    if (error.type === EvalErrorTypes.DEPENDENCY_ERROR) {
      Toaster.show({
        text: error.message,
        variant: Variant.danger,
      });
    }
    if (error.type === EvalErrorTypes.EVAL_TREE_ERROR) {
      Toaster.show({
        text: "Unexpected error occurred while evaluating the app",
        variant: Variant.danger,
      });
      Sentry.captureException(error);
    }
    log.debug(error);
  });
};

function* postEvalActionDispatcher(actions: ReduxAction<unknown>[]) {
  for (const action of actions) {
    yield put(action);
  }
}

function* evaluateTreeSaga(postEvalActions?: ReduxAction<unknown>[]) {
  PerformanceTracker.startAsyncTracking(
    PerformanceTransactionName.DATA_TREE_EVALUATION,
  );
  const unEvalTree = yield select(getUnevaluatedDataTree);
  log.debug({ unEvalTree });

  const workerResponse = yield worker.request(EVAL_WORKER_ACTIONS.EVAL_TREE, {
    dataTree: unEvalTree,
    widgetTypeConfigMap,
  });

  const { errors, dataTree } = workerResponse;
  const parsedDataTree = JSON.parse(dataTree);
  log.debug({ dataTree: parsedDataTree });
  evalErrorHandler(errors);
  yield put({
    type: ReduxActionTypes.SET_EVALUATED_TREE,
    payload: parsedDataTree,
  });
  PerformanceTracker.stopAsyncTracking(
    PerformanceTransactionName.DATA_TREE_EVALUATION,
  );
  if (postEvalActions && postEvalActions.length) {
    yield call(postEvalActionDispatcher, postEvalActions);
  }
}

export function* evaluateSingleValue(
  binding: string,
  executionParams: Record<string, any> = {},
) {
  if (worker.isReady()) {
    const dataTree = yield select(getDataTree);

    const workerResponse = yield worker.request(
      EVAL_WORKER_ACTIONS.EVAL_SINGLE,
      {
        dataTree: Object.assign({}, dataTree, {
          [EXECUTION_PARAM_KEY]: executionParams,
        }),
        binding,
      },
    );

    const { errors, value } = workerResponse;

    evalErrorHandler(errors);
    return value;
  }
}

export function* evaluateDynamicTrigger(
  dynamicTrigger: string,
  callbackData?: Array<any>,
) {
  if (worker.isReady()) {
    const unEvalTree = yield select(getUnevaluatedDataTree);

    const workerResponse = yield worker.request(
      EVAL_WORKER_ACTIONS.EVAL_TRIGGER,
      { dataTree: unEvalTree, dynamicTrigger, callbackData },
    );

    const { errors, triggers } = workerResponse;
    evalErrorHandler(errors);
    return triggers;
  }
  return [];
}

export function* clearEvalCache() {
  if (worker.isReady()) {
    yield worker.request(EVAL_WORKER_ACTIONS.CLEAR_CACHE);

    return true;
  }
}

export function* clearEvalPropertyCache(propertyPath: string) {
  if (worker.isReady()) {
    yield worker.request(EVAL_WORKER_ACTIONS.CLEAR_PROPERTY_CACHE, {
      propertyPath,
    });
  }
}

/**
 * clears all cache keys of a widget
 *
 * @param widgetName
 */
export function* clearEvalPropertyCacheOfWidget(widgetName: string) {
  if (worker.isReady()) {
    yield worker.request(EVAL_WORKER_ACTIONS.CLEAR_PROPERTY_CACHE_OF_WIDGET, {
      widgetName,
    });
  }
}

export function* validateProperty(
  widgetType: WidgetType,
  property: string,
  value: any,
  props: WidgetProps,
) {
  if (worker.isReady()) {
    return yield worker.request(EVAL_WORKER_ACTIONS.VALIDATE_PROPERTY, {
      widgetType,
      property,
      value,
      props,
    });
  }
  return { isValid: true, parsed: value };
}

const EVALUATE_REDUX_ACTIONS = [
  // Actions
  ReduxActionTypes.FETCH_ACTIONS_SUCCESS,
  ReduxActionTypes.FETCH_ACTIONS_VIEW_MODE_SUCCESS,
  ReduxActionErrorTypes.FETCH_ACTIONS_ERROR,
  ReduxActionErrorTypes.FETCH_ACTIONS_VIEW_MODE_ERROR,
  ReduxActionTypes.FETCH_ACTIONS_FOR_PAGE_SUCCESS,
  ReduxActionTypes.SUBMIT_CURL_FORM_SUCCESS,
  ReduxActionTypes.CREATE_ACTION_SUCCESS,
  ReduxActionTypes.UPDATE_ACTION_PROPERTY,
  ReduxActionTypes.DELETE_ACTION_SUCCESS,
  ReduxActionTypes.COPY_ACTION_SUCCESS,
  ReduxActionTypes.MOVE_ACTION_SUCCESS,
  ReduxActionTypes.RUN_ACTION_REQUEST,
  ReduxActionTypes.RUN_ACTION_SUCCESS,
  ReduxActionErrorTypes.RUN_ACTION_ERROR,
  ReduxActionTypes.EXECUTE_API_ACTION_REQUEST,
  ReduxActionTypes.EXECUTE_API_ACTION_SUCCESS,
  ReduxActionErrorTypes.EXECUTE_ACTION_ERROR,
  // App Data
  ReduxActionTypes.SET_APP_MODE,
  ReduxActionTypes.FETCH_USER_DETAILS_SUCCESS,
  ReduxActionTypes.SET_URL_DATA,
  ReduxActionTypes.UPDATE_APP_STORE,
  // Widgets
  ReduxActionTypes.UPDATE_LAYOUT,
  ReduxActionTypes.UPDATE_WIDGET_PROPERTY,
  ReduxActionTypes.UPDATE_WIDGET_NAME_SUCCESS,
  // Widget Meta
  ReduxActionTypes.SET_META_PROP,
  ReduxActionTypes.RESET_WIDGET_META,
  // Pages
  ReduxActionTypes.FETCH_PAGE_SUCCESS,
  ReduxActionTypes.FETCH_PUBLISHED_PAGE_SUCCESS,
  // Batches
  ReduxActionTypes.BATCH_UPDATES_SUCCESS,
];

function* evaluationChangeListenerSaga() {
  yield fork(worker.init);
  yield fork(evaluateTreeSaga);
  while (true) {
    const action: EvaluationReduxAction<unknown | unknown[]> = yield take(
      EVALUATE_REDUX_ACTIONS,
    );
    // When batching success action happens, we need to only evaluate
    // if the batch had any action we need to evaluate properties for
    if (
      action.type === ReduxActionTypes.BATCH_UPDATES_SUCCESS &&
      Array.isArray(action.payload)
    ) {
      const batchedActionTypes = action.payload.map(
        (batchedAction: ReduxAction<unknown>) => batchedAction.type,
      );
      if (
        _.intersection(EVALUATE_REDUX_ACTIONS, batchedActionTypes).length === 0
      ) {
        continue;
      }
    }
    log.debug(`Evaluating`, { action });
    yield fork(evaluateTreeSaga, action.postEvalActions);
  }
  // TODO(hetu) need an action to stop listening and evaluate (exit app)
}

export default function* evaluationSagaListeners() {
  yield all([
    takeLatest(ReduxActionTypes.START_EVALUATION, evaluationChangeListenerSaga),
  ]);
}
