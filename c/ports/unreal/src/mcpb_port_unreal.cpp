// libmcpb port for Unreal Engine 5. See mcpb_port_unreal.h.
//
// The three conventions libmcpb's correctness depends on, enforced here:
//   recv never returns 0   a closed peer is MCPB_ERR_CLOSED, an elapsed wait
//                          is MCPB_ERR_TIMEOUT;
//   send is all-or-fail    FSocket::Send may write less than asked, so it is
//                          looped until the last byte or a failure;
//   open never falls back  tls != 0 is refused.

#include "mcpb_port_unreal.h"

#include "CoreMinimal.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "Misc/Guid.h"
#include "Sockets.h"
#include "SocketSubsystem.h"
#include "IPAddress.h"

namespace
{
    FSocket* SocketOf(const mcpb_port_unreal_t* Ctx)
    {
        return static_cast<FSocket*>(Ctx->socket);
    }

    ISocketSubsystem* SubsystemOf(const mcpb_port_unreal_t* Ctx)
    {
        return static_cast<ISocketSubsystem*>(Ctx->subsystem);
    }

    FTimespan SpanOf(int TimeoutMs)
    {
        // A negative timeout means no limit; FSocket::Wait takes a span, so
        // "no limit" is a very long one.
        return TimeoutMs < 0 ? FTimespan::FromDays(365) : FTimespan::FromMilliseconds(TimeoutMs);
    }

    int u_open(void* ctx, const char* host, uint16_t port, int tls, int timeout_ms)
    {
        mcpb_port_unreal_t* Ctx = static_cast<mcpb_port_unreal_t*>(ctx);
        if (tls)
        {
            return MCPB_ERR_UNSUPPORTED; // never in the clear when asked for TLS
        }
        if (Ctx->socket != nullptr)
        {
            return MCPB_ERR_STATE;
        }
        ISocketSubsystem* SS = SubsystemOf(Ctx);

        const FString HostString = ANSI_TO_TCHAR(host);
        const FString PortString = FString::FromInt(port);
        const FAddressInfoResult Resolved = SS->GetAddressInfo(*HostString, *PortString,
                                                               EAddressInfoFlags::Default, NAME_None,
                                                               SOCKTYPE_Streaming);
        if (Resolved.ReturnCode != SE_NO_ERROR || Resolved.Results.Num() == 0)
        {
            Ctx->last_error = static_cast<int>(Resolved.ReturnCode);
            return MCPB_ERR_IO;
        }

        int Result = MCPB_ERR_IO;
        for (const FAddressInfoResultData& Candidate : Resolved.Results)
        {
            TSharedRef<FInternetAddr> Addr = Candidate.Address;
            FSocket* Socket = SS->CreateSocket(NAME_Stream, TEXT("mcpb"), Addr->GetProtocolType());
            if (Socket == nullptr)
            {
                continue;
            }

            // Non-blocking connect, so the caller's timeout is honoured rather
            // than the OS default, which can be over a minute.
            Socket->SetNonBlocking(true);
            bool bConnected = Socket->Connect(*Addr);
            if (!bConnected)
            {
                const ESocketErrors Err = SS->GetLastErrorCode();
                if (Err == SE_EWOULDBLOCK || Err == SE_EINPROGRESS)
                {
                    if (!Socket->Wait(ESocketWaitConditions::WaitForWrite, SpanOf(timeout_ms)))
                    {
                        Result = MCPB_ERR_TIMEOUT;
                    }
                    else
                    {
                        bConnected = Socket->GetConnectionState() == SCS_Connected;
                        if (!bConnected)
                        {
                            Ctx->last_error = static_cast<int>(SS->GetLastErrorCode());
                        }
                    }
                }
                else
                {
                    Ctx->last_error = static_cast<int>(Err);
                }
            }

            if (!bConnected)
            {
                Socket->Close();
                SS->DestroySocket(Socket);
                continue;
            }

            Socket->SetNonBlocking(false);
            // One JSON-RPC message per frame, written as a header then chunks:
            // without this, Nagle would pair the header with the next chunk.
            Socket->SetNoDelay(true);

            Ctx->socket = Socket;
            Ctx->last_error = 0;
            Result = MCPB_OK;
            break;
        }
        return Result;
    }

    int u_send(void* ctx, const uint8_t* buf, size_t len, int timeout_ms)
    {
        mcpb_port_unreal_t* Ctx = static_cast<mcpb_port_unreal_t*>(ctx);
        FSocket* Socket = SocketOf(Ctx);
        if (Socket == nullptr)
        {
            return MCPB_ERR_STATE;
        }
        size_t Sent = 0;
        while (Sent < len)
        {
            if (timeout_ms >= 0 && !Socket->Wait(ESocketWaitConditions::WaitForWrite, SpanOf(timeout_ms)))
            {
                return MCPB_ERR_TIMEOUT;
            }
            int32 Written = 0;
            if (!Socket->Send(buf + Sent, static_cast<int32>(len - Sent), Written) || Written < 0)
            {
                Ctx->last_error = static_cast<int>(SubsystemOf(Ctx)->GetLastErrorCode());
                return MCPB_ERR_IO;
            }
            Sent += static_cast<size_t>(Written);
        }
        return static_cast<int>(len);
    }

    int u_recv(void* ctx, uint8_t* buf, size_t len, int timeout_ms)
    {
        mcpb_port_unreal_t* Ctx = static_cast<mcpb_port_unreal_t*>(ctx);
        FSocket* Socket = SocketOf(Ctx);
        if (Socket == nullptr)
        {
            return MCPB_ERR_STATE;
        }
        if (!Socket->Wait(ESocketWaitConditions::WaitForRead, SpanOf(timeout_ms)))
        {
            return MCPB_ERR_TIMEOUT;
        }
        int32 Read = 0;
        if (!Socket->Recv(buf, static_cast<int32>(len), Read))
        {
            Ctx->last_error = static_cast<int>(SubsystemOf(Ctx)->GetLastErrorCode());
            return MCPB_ERR_IO;
        }
        if (Read == 0)
        {
            return MCPB_ERR_CLOSED; // readable with nothing to read: the peer closed
        }
        return Read;
    }

    void u_close(void* ctx)
    {
        mcpb_port_unreal_t* Ctx = static_cast<mcpb_port_unreal_t*>(ctx);
        FSocket* Socket = SocketOf(Ctx);
        if (Socket == nullptr)
        {
            return;
        }
        Socket->Close();
        SubsystemOf(Ctx)->DestroySocket(Socket);
        Ctx->socket = nullptr;
    }

    uint32_t u_now_ms(void* ctx)
    {
        (void)ctx;
        // Wraps every 49.7 days by design; libmcpb only takes differences.
        return static_cast<uint32_t>(FPlatformTime::Seconds() * 1000.0);
    }

    void u_sleep_ms(void* ctx, uint32_t ms)
    {
        (void)ctx;
        // On the link's worker thread, never the game thread (McpBrokerLink).
        FPlatformProcess::Sleep(static_cast<float>(ms) / 1000.0f);
    }

    int u_random(void* ctx, uint8_t* buf, size_t len)
    {
        mcpb_port_unreal_t* Ctx = static_cast<mcpb_port_unreal_t*>(ctx);
        // A GUID from the platform: sixteen bytes the OS draws unpredictably
        // (CoCreateGuid on Windows, uuid_generate elsewhere). The WebSocket
        // mask is not a secret (RFC 6455 uses it against proxy cache
        // poisoning), it only has to be unpredictable, which this is.
        size_t Done = 0;
        while (Done < len)
        {
            if (Ctx->pool_left == 0)
            {
                const FGuid Guid = FGuid::NewGuid();
                FMemory::Memcpy(Ctx->pool, &Guid, sizeof(Ctx->pool));
                Ctx->pool_left = sizeof(Ctx->pool);
            }
            buf[Done++] = Ctx->pool[sizeof(Ctx->pool) - Ctx->pool_left];
            Ctx->pool_left--;
        }
        return MCPB_OK;
    }
}

extern "C" int mcpb_port_unreal_init(mcpb_port_t* port, mcpb_port_unreal_t* ctx)
{
    if (port == nullptr || ctx == nullptr)
    {
        return MCPB_ERR_ARG;
    }
    ISocketSubsystem* SS = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
    if (SS == nullptr)
    {
        return MCPB_ERR_UNSUPPORTED;
    }
    FMemory::Memzero(ctx, sizeof(*ctx));
    ctx->subsystem = SS;

    port->ctx = ctx;
    port->open = u_open;
    port->send = u_send;
    port->recv = u_recv;
    port->close = u_close;
    port->now_ms = u_now_ms;
    port->random = u_random;
    port->sleep_ms = u_sleep_ms;
    return mcpb_port_check(port);
}
