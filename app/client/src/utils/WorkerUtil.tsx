import { all, cancel, put, take, takeEvery } from "redux-saga/effects";
import { eventChannel, EventChannel, channel, Channel, END } from "redux-saga";
import _ from "lodash";

export class GracefulWorker {
  private _channels: {
    [requestId: string]: Channel<any>;
  };
  private _workerChannel: EventChannel<any> | undefined;
  private _evaluationWorker: Worker | undefined;
  private _cancelBroker: any;
  private _readyChan: Channel<any>;
  private _isReady: boolean;
  private _workerClass: any;

  constructor(workerClass: any) {
    this.start = this.start.bind(this);
    this.request = this.request.bind(this);
    this._broker = this._broker.bind(this);
    this._readyChan = channel();
    this._isReady = false;
    this._channels = {};
    this._workerClass = workerClass;
  }

  *shutdown() {
    // Ignore if already shutdown
    if (!this._evaluationWorker) return;
    // stop accepting new requests
    this._isReady = false;
    // wait for current responses to drain
    yield all(Object.values(this._channels).map((c) => take(c)));
    // close the worker
    yield this._workerChannel?.close();
    // stop the broker
    // Todo: figure out if we need to do it.
    yield cancel(this._cancelBroker);
  }

  *start() {
    // Todo: call this on editor unmount as part of a separate PR
    yield this.shutdown();
    this._evaluationWorker = new this._workerClass();
    this._workerChannel = eventChannel((emitter) => {
      if (!this._evaluationWorker) {
        // Impossible case unless something really went wrong
        // END the channel in that case
        emitter(END);
        return _.noop;
      }

      this._evaluationWorker.addEventListener("message", emitter);
      // The subscriber must return an unsubscribe function
      return () => {
        if (!this._evaluationWorker) return;
        // stop listening.
        this._evaluationWorker.removeEventListener("message", emitter);
        // Terminate the evaluation worker
        this._evaluationWorker.terminate();
        // set it to undefined
        this._evaluationWorker = undefined;
      };
    });

    this._cancelBroker = yield takeEvery(this._workerChannel, this._broker);
    // Inform all waiters that we can move forward
    this._isReady = true;
    yield put(this._readyChan, true);
  }

  *request(action: string, payload = {}) {
    if (!this._evaluationWorker || !this._isReady) {
      // Block request till we are ready.
      yield take(this._readyChan);
      // Impossible case, but helps avoid `?` later in code and makes it clearer.
      if (!this._evaluationWorker) return;
    }

    const requestId = `${action}__${_.uniqueId()}`;
    this._channels[requestId] = channel();
    this._evaluationWorker.postMessage({
      action,
      payload,
      requestId,
    });
    const response = yield take(this._channels[requestId]);
    yield this._channels[requestId].close();
    delete this._channels[requestId];
    return response;
  }

  private *_broker(event: MessageEvent) {
    if (!event || !event.data) {
      return;
    }
    const { requestId, payload } = event.data;
    yield put(this._channels[requestId], payload);
  }
}
