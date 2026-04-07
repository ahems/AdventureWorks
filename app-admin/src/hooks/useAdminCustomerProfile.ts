import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { getRestApiUrl } from "@/lib/utils";
import { gql } from "graphql-request";

export interface AdminCustomerProfile {
  BusinessEntityID: number;
  Title?: string | null;
  FirstName: string;
  MiddleName?: string | null;
  LastName: string;
  Suffix?: string | null;
  EmailAddress: string;
  EmailAddressID?: number;
  PhoneNumber?: string | null;
  PhoneNumberTypeID?: number | null;
}

const GET_CUSTOMER_PROFILE = gql`
  query GetCustomerProfile($businessEntityId: Int!) {
    person_by_pk(BusinessEntityID: $businessEntityId) {
      BusinessEntityID
      Title
      FirstName
      MiddleName
      LastName
      Suffix
    }
    emailAddresses(filter: { BusinessEntityID: { eq: $businessEntityId } }) {
      items {
        EmailAddressID
        EmailAddress
      }
    }
    personPhones(filter: { BusinessEntityID: { eq: $businessEntityId } }) {
      items {
        PhoneNumber
        PhoneNumberTypeID
      }
    }
  }
`;

const UPDATE_PERSON = gql`
  mutation UpdatePerson(
    $businessEntityId: Int!
    $title: String
    $firstName: String!
    $middleName: String
    $lastName: String!
    $suffix: String
  ) {
    updatePerson(
      BusinessEntityID: $businessEntityId
      item: {
        Title: $title
        FirstName: $firstName
        MiddleName: $middleName
        LastName: $lastName
        Suffix: $suffix
      }
    ) {
      BusinessEntityID
      Title
      FirstName
      MiddleName
      LastName
      Suffix
    }
  }
`;

const UPDATE_EMAIL_ADDRESS = gql`
  mutation UpdateEmailAddress(
    $businessEntityId: Int!
    $emailAddressId: Int!
    $emailAddress: String!
  ) {
    updateEmailAddress(
      BusinessEntityID: $businessEntityId
      EmailAddressID: $emailAddressId
      item: { EmailAddress: $emailAddress }
    ) {
      EmailAddressID
      EmailAddress
    }
  }
`;

export const useAdminCustomerProfile = (businessEntityId: number | null) => {
  return useQuery<AdminCustomerProfile | null>({
    queryKey: ["admin", "customer-profile", businessEntityId],
    enabled: businessEntityId != null && businessEntityId > 0,
    queryFn: async () => {
      const data = await graphqlClient.request<{
        person_by_pk: {
          BusinessEntityID: number;
          Title?: string | null;
          FirstName: string;
          MiddleName?: string | null;
          LastName: string;
          Suffix?: string | null;
        } | null;
        emailAddresses: {
          items: Array<{ EmailAddressID: number; EmailAddress: string }>;
        };
        personPhones: {
          items: Array<{ PhoneNumber: string; PhoneNumberTypeID: number }>;
        };
      }>(GET_CUSTOMER_PROFILE, {
        businessEntityId,
      });

      const person = data.person_by_pk;
      if (!person) return null;

      const email = data.emailAddresses?.items?.[0];
      const phone = data.personPhones?.items?.[0];

      return {
        BusinessEntityID: person.BusinessEntityID,
        Title: person.Title ?? null,
        FirstName: person.FirstName,
        MiddleName: person.MiddleName ?? null,
        LastName: person.LastName,
        Suffix: person.Suffix ?? null,
        EmailAddress: email?.EmailAddress ?? "",
        EmailAddressID: email?.EmailAddressID,
        PhoneNumber: phone?.PhoneNumber ?? null,
        PhoneNumberTypeID: phone?.PhoneNumberTypeID ?? null,
      };
    },
    staleTime: 2 * 60 * 1000,
  });
};

export const useAdminUpdateCustomerProfile = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (profile: AdminCustomerProfile) => {
      const restApiUrl = getRestApiUrl();

      // 1. Update Person record
      await graphqlClient.request(UPDATE_PERSON, {
        businessEntityId: profile.BusinessEntityID,
        title: profile.Title || null,
        firstName: profile.FirstName,
        middleName: profile.MiddleName || null,
        lastName: profile.LastName,
        suffix: profile.Suffix || null,
      });

      // 2. Update email if we have the ID
      if (profile.EmailAddressID) {
        await graphqlClient.request(UPDATE_EMAIL_ADDRESS, {
          businessEntityId: profile.BusinessEntityID,
          emailAddressId: profile.EmailAddressID,
          emailAddress: profile.EmailAddress,
        });
      }

      // 3. Update or create phone (composite PK = delete-then-insert)
      if (profile.PhoneNumber !== undefined) {
        const phoneTypeId = profile.PhoneNumberTypeID || 1;

        // Delete any existing phones
        const existing = await fetch(
          `${restApiUrl}/PersonPhone?$filter=BusinessEntityID eq ${profile.BusinessEntityID}`,
        ).then((r) => r.json());

        if (existing.value?.length > 0) {
          for (const p of existing.value) {
            await fetch(
              `${restApiUrl}/PersonPhone/BusinessEntityID/${profile.BusinessEntityID}/PhoneNumber/${encodeURIComponent(p.PhoneNumber)}/PhoneNumberTypeID/${p.PhoneNumberTypeID}`,
              { method: "DELETE" },
            );
          }
        }

        // Insert new phone (only if non-empty)
        if (profile.PhoneNumber) {
          await fetch(`${restApiUrl}/PersonPhone`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              BusinessEntityID: profile.BusinessEntityID,
              PhoneNumber: profile.PhoneNumber,
              PhoneNumberTypeID: phoneTypeId,
            }),
          });
        }
      }
    },
    onSuccess: (_, profile) => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "customer-profile", profile.BusinessEntityID],
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
    },
  });
};
