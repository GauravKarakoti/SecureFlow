FROM alpine:3.19.1
RUN apk add --no-cache curl
CMD ["curl", "https://example.com"]
