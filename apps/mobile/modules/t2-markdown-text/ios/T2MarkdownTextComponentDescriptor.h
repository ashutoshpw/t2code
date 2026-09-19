#pragma once

#include "T2MarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using T2MarkdownTextComponentDescriptor = ConcreteComponentDescriptor<T2MarkdownTextShadowNode>;

void T2MarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
