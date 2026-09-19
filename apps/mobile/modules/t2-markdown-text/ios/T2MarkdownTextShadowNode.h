#pragma once

#include <react/renderer/components/T2MarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/T2MarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char T2MarkdownTextComponentName[];

struct T2MarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct T2MarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
  /// Recolor the loaded image with the run's foreground color, like `sf:` symbols.
  bool tintWithForeground;
  Float chipWidth = 0;
  Float chipHeight = 0;
};

inline Float T2MarkdownTextAttachmentSize(const T2MarkdownTextAttachmentRange &) {
  return 14;
}

inline Float T2MarkdownTextAttachmentBaselineOffset(
    const T2MarkdownTextAttachmentRange &) {
  return -2;
}

class T2MarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<T2MarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<T2MarkdownTextAttachmentRange> attachmentRanges;
};

class T2MarkdownTextShadowNode final : public ConcreteViewShadowNode<
T2MarkdownTextComponentName,
T2MarkdownTextProps,
T2MarkdownTextEventEmitter,
T2MarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  T2MarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<T2MarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<T2MarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
