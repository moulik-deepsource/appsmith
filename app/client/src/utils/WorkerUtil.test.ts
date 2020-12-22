import { GracefulWorker } from "./WorkerUtil";

const MessageType = "message";

class MockWorker {
  callback: CallableFunction;
  noop: CallableFunction;
  messages: Array<any>;
  delaySeconds: number;

  constructor() {
    /* eslint-disable @typescript-eslint/no-empty-function */
    this.noop = () => {};
    this.callback = this.noop;
    this.messages = [];
    this.delaySeconds = 0;
  }

  addEventListener(msgType: string, callback: CallableFunction) {
    expect(msgType).toEqual(MessageType);
    this.callback = callback;
  }

  removeEventListener(msgType: string, callback: CallableFunction) {
    expect(msgType).toEqual(MessageType);
    expect(callback).toEqual(this.callback);
    this.callback = this.noop;
  }

  postMessage(message: any) {
    this.messages.push(message);
    setTimeout(() => {
      this.sendEvent({ data: message });
    }, this.delaySeconds * 1000);
  }

  sendEvent(ev: any) {
    expect(this.callback).not.toEqual(this.noop);
    this.callback(ev);
  }
}

describe("GracefulWorker", () => {
  const startWorker = (w: GracefulWorker) => {
    const start = w.start();
    start.next(); // w.shutdown
    {
      //Inside shutdown
      start.next(); // return from empty
    }
    start.next(); // register broker
    expect(start.next().done).toEqual(true);
    return w;
  };

  test("Worker should start", () => {
    startWorker(new GracefulWorker(MockWorker));
  });

  //   test("Request should respond", () => {
  //     const w = startWorker(new GracefulWorker(MockWorker));
  //     const data = { tree: "hello" };
  //     const req = w.request("test", data);
  //     req.next(); // yield the take
  //     expect(req.next().value).toEqual(data);
  //   });
});
