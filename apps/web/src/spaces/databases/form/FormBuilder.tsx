import { knownProperty, type FormQuestionModel } from "@t2code/client-runtime/spaces";
import {
  isFormAnswerType,
  SPACE_FORM_DESCRIPTION_MAX,
  SPACE_FORM_LABEL_MAX,
  SPACE_FORM_MAX_QUESTIONS,
  type SpaceFormQuestion,
  type SpacePropertyId,
} from "@t2code/contracts/spaces";
import { PlusIcon, SendIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { DraftInput } from "~/components/ui/draft-input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Switch } from "~/components/ui/switch";
import { useEnvironment } from "~/state/environments";
import { openSpacePageShareDialog } from "../../spacePageShareDialogState";
import { useDatabaseBlockHost } from "../blocks/DatabaseBlockHost";
import { SortableList, SortableRow } from "../controls/Sortable";
import { PropertyTypeIcon } from "../primitives/PropertyTypeIcon";
import { useViewControls } from "../controls/useViewControls";
import { useDatabase } from "../shell/context";
import { FormFill } from "./FormFill";

/** The form for people who can edit the view: its title, description and questions, with a preview. */
export function FormBuilder({
  questions,
}: {
  readonly questions: ReadonlyArray<FormQuestionModel>;
}) {
  const { model, known, dataSource, actions, view } = useViewControls();
  const { blockId } = useDatabase();
  const host = useDatabaseBlockHost();
  const features = useEnvironment(model.environmentId)?.serverConfig?.environment.capabilities
    .spaces?.features;
  const [preview, setPreview] = useState(false);
  if (known?.type !== "form") return null;
  const { layout } = known;
  const all = layout.questions ?? [];
  const live = new Set(questions.map((question) => question.propertyId));
  const write = (next: ReadonlyArray<SpaceFormQuestion>) =>
    actions.editView({ layout: { ...layout, questions: [...next] } });
  const patch = (propertyId: SpacePropertyId, change: Partial<SpaceFormQuestion>) =>
    write(
      all.map((question) =>
        question.propertyId === propertyId ? { ...question, ...change } : question,
      ),
    );
  const addable = Object.values(dataSource.properties)
    .flatMap((raw) => {
      const property = knownProperty(raw);
      return property !== null && isFormAnswerType(property.type) && !live.has(property.id)
        ? [{ id: property.id, name: property.name, type: property.type, position: raw.position }]
        : [];
    })
    .sort((a, b) => a.position - b.position);
  const pageId = host?.pageId ?? model.database.home?.pageId;
  const shareBlockId = host === null ? model.database.home?.blockId : blockId;
  const canShare =
    features?.databaseChartFormFeed === true && pageId !== undefined && shareBlockId !== undefined;
  const dead = all.filter((question) => !live.has(question.propertyId));

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div role="group" aria-label="Form mode" className="flex gap-1">
          <Button
            size="xs"
            variant={preview ? "ghost-muted" : "outline"}
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
          >
            Edit
          </Button>
          <Button
            size="xs"
            variant={preview ? "outline" : "ghost-muted"}
            aria-pressed={preview}
            onClick={() => setPreview(true)}
          >
            Preview
          </Button>
        </div>
        {canShare ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              openSpacePageShareDialog({
                environmentId: model.environmentId,
                pageId,
                form: { blockId: shareBlockId, viewId: view.id },
              })
            }
          >
            <SendIcon />
            Share form
          </Button>
        ) : null}
      </div>
      {preview ? (
        <FormFill questions={questions} />
      ) : (
        <>
          <DraftInput
            aria-label="Form title"
            value={view.name}
            onCommit={(name) => actions.renameView(view.id, name)}
          />
          <DraftInput
            aria-label="Form description"
            placeholder="Form description"
            maxLength={SPACE_FORM_DESCRIPTION_MAX}
            value={layout.description ?? ""}
            onCommit={(description) => {
              const { description: _, ...rest } = layout;
              actions.editView({
                layout: description === "" ? rest : { ...rest, description },
              });
            }}
          />
          {questions.length === 0 ? (
            <p className="text-muted-foreground text-sm">This form has no questions.</p>
          ) : (
            <SortableList
              ids={questions.map((question) => question.propertyId)}
              onReorder={(ids) =>
                write([
                  ...ids.flatMap((id) => all.filter((question) => question.propertyId === id)),
                  ...dead,
                ])
              }
            >
              <div className="flex flex-col gap-2">
                {questions.map((question) => (
                  <SortableRow
                    key={question.propertyId}
                    id={question.propertyId}
                    label={question.label}
                    className="items-start rounded-lg border p-2"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <div className="flex items-center gap-1.5">
                        <PropertyTypeIcon type={question.type} />
                        <DraftInput
                          size="compact"
                          aria-label={`Label of ${question.label}`}
                          maxLength={SPACE_FORM_LABEL_MAX}
                          value={question.label}
                          onCommit={(label) => {
                            const trimmed = label.trim();
                            if (trimmed !== "") patch(question.propertyId, { label: trimmed });
                          }}
                        />
                      </div>
                      <DraftInput
                        size="compact"
                        aria-label={`Description of ${question.label}`}
                        placeholder="Description"
                        maxLength={SPACE_FORM_DESCRIPTION_MAX}
                        value={question.description ?? ""}
                        onCommit={(description) => patch(question.propertyId, { description })}
                      />
                      <label className="flex items-center gap-2 text-xs">
                        <Switch
                          size="sm"
                          aria-label={`Require ${question.label}`}
                          checked={question.required}
                          onCheckedChange={(required) => patch(question.propertyId, { required })}
                        />
                        Required
                      </label>
                    </div>
                    <Button
                      variant="ghost-destructive"
                      size="icon-xs"
                      aria-label={`Remove ${question.label}`}
                      onClick={() =>
                        write(all.filter((entry) => entry.propertyId !== question.propertyId))
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </SortableRow>
                ))}
              </div>
            </SortableList>
          )}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  className="self-start"
                  disabled={addable.length === 0 || all.length >= SPACE_FORM_MAX_QUESTIONS}
                />
              }
            >
              <PlusIcon />
              Add question
            </MenuTrigger>
            <MenuPopup align="start">
              {addable.map((property) => (
                <MenuItem
                  key={property.id}
                  onClick={() => write([...all, { propertyId: property.id }])}
                >
                  <PropertyTypeIcon type={property.type} />
                  {property.name}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
          <p className="text-muted-foreground text-xs">
            Questions are properties of this database. Add more in Properties.
          </p>
        </>
      )}
    </div>
  );
}
