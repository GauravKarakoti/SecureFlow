data "aws_iam_policy_document" "scoped_access" {
  statement {
    sid       = "ScopedS3Read"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = ["arn:aws:s3:::app-data-bucket/*"]
  }

  statement {
    sid       = "WildcardActionOnScopedResource"
    effect    = "Allow"
    actions   = ["*"]
    resources = ["arn:aws:s3:::app-data-bucket/*"]
  }
}
