import { useEffect, useId, useState } from "react";
import { CalendarIcon } from "lucide-react";
import { create } from "zustand";
import {
  defaultSendLaterDate,
  formatSendLaterLabel,
  resolveSendLater,
  SEND_LATER_ERROR_MESSAGES,
} from "@t2code/client-runtime/state/send-later";
import { localSnoozeDate, localSnoozeTime } from "@t2code/client-runtime/state/thread-settled";

import { weekStartsOn } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Calendar } from "../ui/calendar";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

type Request = { readonly resolve: (at: string | null) => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Resolves with the chosen UTC instant, or null when the user cancels. */
export function requestSendLater(): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { resolve } }));
}

function finish(at: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(at);
}

export function SendLaterDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <SendLaterDialog /> : null;
}

function SendLaterDialog() {
  const id = useId();
  const [initial] = useState(() => defaultSendLaterDate(new Date()));
  const [date, setDate] = useState(initial);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [time, setTime] = useState(localSnoozeTime(initial));
  const [error, setError] = useState<string | null>(null);
  const resolution = resolveSendLater({ date: localSnoozeDate(date), time }, new Date());
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const next = resolveSendLater({ date: localSnoozeDate(date), time }, new Date());
            if (!next.ok) {
              setError(SEND_LATER_ERROR_MESSAGES[next.reason]);
              return;
            }
            finish(next.at);
          }}
        >
          <DialogHeader>
            <DialogTitle>Send later</DialogTitle>
            <DialogDescription>
              Choose when to send this message to the thread. It also appears under Scheduled tasks,
              where you can change the time or cancel it.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={`${id}-date`}>Date</Label>
                <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                  <PopoverTrigger
                    render={
                      <Button
                        id={`${id}-date`}
                        variant="outline"
                        className="w-full justify-between"
                      />
                    }
                  >
                    {date.toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                    <CalendarIcon className="size-4 text-muted-foreground" />
                  </PopoverTrigger>
                  <PopoverPopup align="start" aria-label="Choose send date">
                    <Calendar
                      mode="single"
                      required
                      selected={date}
                      defaultMonth={date}
                      {...(weekStartsOn === undefined ? {} : { weekStartsOn })}
                      disabled={{ before: new Date(new Date().setHours(0, 0, 0, 0)) }}
                      onSelect={(selected) => {
                        setDate(selected);
                        setCalendarOpen(false);
                        setError(null);
                      }}
                    />
                  </PopoverPopup>
                </Popover>
              </div>
              <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-time`}>
                Time
                <Input
                  nativeInput
                  id={`${id}-time`}
                  className="h-9 sm:h-8"
                  type="time"
                  required
                  value={time}
                  onChange={(event) => {
                    setTime(event.target.value);
                    setError(null);
                  }}
                />
              </Label>
            </div>
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : resolution.ok ? (
              <p className="text-muted-foreground text-sm" role="status">
                Sends {formatSendLaterLabel(resolution.at, new Date())}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">Schedule</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
