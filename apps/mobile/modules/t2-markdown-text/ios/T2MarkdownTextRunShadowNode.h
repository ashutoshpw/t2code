#pragma once

#include <react/renderer/components/T2MarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/T2MarkdownTextSpec/Props.h>
#include <react/renderer/components/T2MarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char T2MarkdownTextRunComponentName[];

using T2MarkdownTextRunShadowNode = ConcreteViewShadowNode<
    T2MarkdownTextRunComponentName,
    T2MarkdownTextRunProps,
    T2MarkdownTextRunEventEmitter,
    T2MarkdownTextRunState>;
}
