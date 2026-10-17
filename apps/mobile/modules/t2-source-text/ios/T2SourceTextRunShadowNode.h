#pragma once

#include <react/renderer/components/T2SourceTextSpec/EventEmitters.h>
#include <react/renderer/components/T2SourceTextSpec/Props.h>
#include <react/renderer/components/T2SourceTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char T2SourceTextRunComponentName[];

using T2SourceTextRunShadowNode =
    ConcreteViewShadowNode<T2SourceTextRunComponentName, T2SourceTextRunProps,
                           T2SourceTextRunEventEmitter, T2SourceTextRunState>;
} // namespace facebook::react
